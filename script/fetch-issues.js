const fs = require('fs');
const moment = require('moment');
const GraphQL = require('graphql-client');
const sleep = require('sleep');
const { DEPLOY_PREVIEW: isDeployPreview } = require('netlify-env');

const {
  GITHUB_ISSUE_INFO_QUERY,
  GITHUB_PR_INFO_QUERY,
  GITHUB_LABEL_INFO_QUERY,
  GITHUB_REACTION_INFO_QUERY
} = require('./queries');

const GH_GQL_BASE = 'https://api.github.com/graphql';
const GH_GQL_OPTIONS = {
  url: GH_GQL_BASE,
  headers: process.env.GITHUB_TOKEN
    ? { Authorization: `bearer ${process.env.GITHUB_TOKEN}` }
    : {}
};

const client = GraphQL(GH_GQL_OPTIONS);

const getTime = timeString => moment(timeString).toDate().getTime();

// number of pages we want to query
// if PAGE_THRESHOLD is -1, then fetch all issues/PRs
const pageThreshold = process.env.PAGE_THRESHOLD || -1;
console.log('page number threshold:', pageThreshold);

// earliest date we want to query from
// GitHub supports reactions since 2016-03-10
let earliestDate = process.env.EARLIEST_DATE || '2017-01-01T00:00:00Z';

if (isDeployPreview) {
  const earliestDateForPr = process.env.EARLIEST_DATE_PR ||
    '2018-04-01T00:00:00Z';
  if (getTime(earliestDate) < getTime(earliestDateForPr)) {
    earliestDate = earliestDateForPr;
    console.log('To speed up netlify pr build, set earliest date threshold',
      earliestDate);
  }
}

const repo = process.env.REPOSITORIES;

// review will be ignored if it's written by any author specified here
// delimiter: space
const ignoreReviewAuthor = process.env.IGNORE_REVIEW_AUTHOR ||
  'gitmate-bot rultor';

// review will be ignored if it matches any string specified here
// it can be a literal or a regular expression
// delimiter: space
const ignoreReviewContent = process.env.IGNORE_REVIEW_CONTENT ||
  '@gitmate-bot @rultor /^(unack|ack)/g';

if (!repo) {
  console.log('No repositories to cache. Skipping.');
  process.exit();
}

const repoOwner = repo.split(':')[0];
const repoNames = repo.substring(repo.indexOf(':') + 1).split('|');

console.log('Fetching issues data for', repoOwner, repoNames);

async function fetchReactionsOfPR(owner, name, number, reviewCnt,
  maxCommentsPerReview, commentCnt) {
  let data, errors;
  try {
    ({ data, errors } = await client.query(
      GITHUB_REACTION_INFO_QUERY,
      {owner, name, number, reviewCnt, maxCommentsPerReview, commentCnt}
    ));
  } catch (error) {
    console.log('fetch reactions of pr failed, owner:', owner,
      'name:', name, 'number:', number, 'error:', error);
  }

  let rawComments = null;
  if (data) {
    // collect review comments
    rawComments = data.repository.pullRequest.reviews.nodes.map(
      node => node.comments.nodes);
    rawComments = [].concat.apply([], rawComments);
    // collect issue comments
    rawComments = rawComments.concat(
      data.repository.pullRequest.comments.nodes);
  } else {
    console.log('warning: no available reaction data!',
      'owner:', owner, 'name:', name, 'pull request number:', number,
      'reviewCnt:', reviewCnt, 'maxCommentsPerReview', maxCommentsPerReview,
      'commentCnt', commentCnt, 'error:', errors);
  }
  // reactions are wrapped by corresponding comment
  return rawComments;
};

async function fetchNextPage(owner, name, isIssue, data, cursor,
  pageCount, warningCnt) {
  // fetch data of next page
  console.log('owner:', owner, 'name:', name, 'isIssue:', isIssue,
    'cursor:', cursor, 'page count:', pageCount);

  let nextData = null, hasPreviousPage = false, reachDateThreshold = false;
  let errors = null;
  try {
    if (isIssue) {
      ({ data: nextData, errors } = await client.query(
        GITHUB_ISSUE_INFO_QUERY,
        {owner, name, before: cursor}
      ));
    } else {
      ({ data: nextData, errors } = await client.query(
        GITHUB_PR_INFO_QUERY,
        {owner, name, before: cursor}
      ));
    }
  } catch (error) {
    console.log('owner:', owner, 'name:', name, 'isIssue:', isIssue,
      'cursor:', cursor, 'error:', error);
  }
  if (nextData && nextData.repository) {
    pageCount++;
    let nodes = [];
    if (isIssue) {
      ({ nodes, pageInfo } = nextData.repository.issues);
    } else {
      ({ nodes, pageInfo } = nextData.repository.pullRequests);
    }
    cursor = pageInfo.startCursor;
    hasPreviousPage = pageInfo.hasPreviousPage;
    const result = await Promise.all(nodes.map(async node => {
      let user, assignee, milestone;
      if (getTime(node.createdAt) < getTime(earliestDate)) {
        reachDateThreshold = true;
      }

      if (node.author) {
        user = {
          login: node.author.login,
          avatarUrl: node.author.avatarUrl
        };
      } else {
        user = {
          login: null,
          avatarUrl: null
        };
      }

      if (node.assignees.nodes && node.assignees.nodes.length) {
        assignee = {
          login: node.assignees.nodes[0].login,
          avatarUrl: node.assignees.nodes[0].avatarUrl
        };
      } else {
        assignee = null;
      }

      if (node.milestone) {
        milestone = {
          title: node.milestone.title,
          createdAt: node.milestone.createdAt,
          dueOn: node.milestone.dueOn,
          state: node.milestone.state.toLowerCase(),
          htmlUrl: node.milestone.url,
          description: node.milestone.description
        };
      } else {
        milestone = {
          title: null,
          createdAt: null,
          dueOn: null,
          state: null,
          htmlUrl: null,
          description: null
        };
      }

      let info = {
        repoOwner: owner,
        repoName: name,
        updatedAtMs: getTime(node.updatedAt),
        issue: {
          htmlUrl: node.url,
          number: node.number,
          title: node.title,
          body: node.bodyText,
          comments: node.comments.totalCount,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
          closedAt: node.closedAt,
          state: node.state.toLowerCase(),
          user: user,
          owner: user,
          assignee: assignee,
          milestone: milestone,
          labels: node.labels.nodes.map(label => ({
            name: label.name,
            color: label.color
          }))
        }
      };
      if (!isIssue) {
        let rawComments, comments;
        // collect review comments
        rawComments = node.reviews.nodes.map(node => node.comments.nodes);
        rawComments = [].concat.apply([], rawComments);
        // collect issue comments
        rawComments = rawComments.concat(node.comments.nodes);

        // fetch reactions only if there are reactions within that PR
        // to reduce API hits.
        // trick: a comment has received reaction(s) iff
        // reactionGroup.createdAt attribute is not null
        const hasReactions = rawComments.reduce((has, rawComment) => {
          return has || rawComment.reactionGroups.reduce((flag, node) => {
            return (flag || node.createdAt) ? true : false;
          }, false);
        }, false);

        if (hasReactions) {
          console.log('pull request has reactions. repoOwner:', owner,
            'repoName:', name, 'pullRequest number:', node.number);
          const number = node.number;
          const reviewCnt = Math.min(node.reviews.totalCount, 20);
          const maxCommentsPerReview = Math.min(
            node.reviews.nodes.reduce(
              (max, review) => Math.max(max, review.comments.totalCount), 0),
            100);
          const commentCnt = Math.min(node.comments.totalCount, 100);
          const commentsWithReactions = await fetchReactionsOfPR(owner, name,
            number, reviewCnt, maxCommentsPerReview, commentCnt);

          // merge rawComments with commentsWithReactions
          if (commentsWithReactions && commentsWithReactions.length) {
            rawComments.forEach((comment, index) => {
              if (comment.id !== commentsWithReactions[index].id) {
                console.log('warning: comments and reactions do not fit!',
                  'pr number:', number, 'comment.id:', comment.id,
                  'comment with reactions id:', commentsWithReactions[index].id);
              } else {
                comment.reactions = commentsWithReactions[index].reactions;
              }
            });
          }
        }

        // filter out useless reviews
        rawComments = rawComments.filter(node => {
          let flag = true;
          // filter comments that don't need meta-reviews
          for (const ignoreContent of ignoreReviewContent.split(' ')) {
            if (node.bodyText.match(ignoreContent)) {
              // filter reviews with specific content
              flag = false;
            }
          }
          for (const ignoreAuthor of ignoreReviewAuthor.split(' ')) {
            if (node.author && node.author.login === ignoreAuthor) {
              // filter reviews done by specific authors
              flag = false;
            }
          }
          return flag;
        });

        comments = rawComments.map(node => {
          let commentAuthor, reactions;

          if (node.author) {
            commentAuthor = {
              login: node.author.login,
              avatarUrl: node.author.avatarUrl,
              name: node.author.name
            };
          } else {
            commentAuthor = {
              login: null,
              avatarUrl: null
            };
          }

          if (node.reactions) reactions = node.reactions.nodes;

          return {
            id: node.id,
            url: node.url,
            bodyText: node.bodyText,
            diffHunk: node.diffHunk ? node.diffHunk : null,
            author: commentAuthor,
            reactions,
            createdAt: node.createdAt,
            lastEditedAt: node.lastEditedAt,
            updatedAt: node.lastEditedAt ? node.lastEditedAt : node.createdAt
          };
        });
        info.issue.pullRequest = {
          htmlUrl: node.url,
          comments
        };
      }
      return info;
    }));
    data = data.concat(result);
    if (hasPreviousPage && !reachDateThreshold &&
       (pageCount < pageThreshold || pageThreshold == -1)) {
      return fetchNextPage(owner, name, isIssue, data,
        cursor, pageCount, 0);
    } else {
      return data;
    }
  } else {
    console.log('Warning: no available data. owner:', owner, 'name:', name,
      'isIssue:', isIssue, 'pageCount:', pageCount, 'error message:', errors);
    warningCnt += 1;
    sleep.sleep(3);
    if (warningCnt < 15) {
      console.log('warning count:', warningCnt);
      return fetchNextPage(owner, name, isIssue, data, cursor, pageCount, warningCnt);
    } else {
      console.log('number of warning exceeds threshold (15), stop fetching on this repo');
      return data;
    }
  }
}

async function fetchIssue(owner, names, isIssue) {
  let result = [];
  for (const name of names) {
    try {
      result = result.concat(
        await fetchNextPage(owner, name, isIssue, [], null, 0, 0));
    } catch (error) {
      console.log('repo owner:', owner, 'repo name:', name,
        'is issue:', isIssue, 'error:', error);
    }
  }
  return result;
}

function fetchLabel(owner, names) {
  return Promise.all(names.map(async name => {
    try {
      const { data } = await client.query(GITHUB_LABEL_INFO_QUERY,  {owner, name});
      let result = [];
      if (data && data.repository) {
        result = data.repository.labels.nodes.map(node => ({
          id: node.id,
          name: node.name,
          color: node.color,
          default: node.isDefault,
        }));
      }
      return {
        repoOwner: owner,
        repoName: name,
        labels: result,
      };
    } catch (error) {
      console.log(error);
    }
  }));
}

function generateRepoInfo(owner, names, issues) {
  let result = [], map = {};
  for (const issue of issues) {
    const updatedAt = issue.issue.updatedAt;
    const repoName = issue.repoName;
    if (repoName in map) {
      if (getTime(updatedAt) > getTime(map[repoName])) {
        map[repoName] = updatedAt;
      }
    } else {
      map[repoName] = updatedAt;
    }
  }
  for (const name of names) {
    result.push({
      repoOwner: owner,
      repoName: name,
      isPrivate: false,
      lastSeenAt: map[name]
    });
  }
  return result;
}

function filterRecent(issues) {
  // only keep issues created/updated in the past month
  const today = new Date();
  const dayLastMonth = getTime(today.setMonth(today.getMonth() - 1));
  return issues.filter(issue => dayLastMonth < issue.updatedAtMs);
}

;(async () => {
  let issueInfo, prInfo, labelInfo;
  try {
    [issueInfo, labelInfo, prInfo] = await Promise.all([
      fetchIssue(repoOwner, repoNames, true),
      fetchLabel(repoOwner, repoNames),
      fetchIssue(repoOwner, repoNames, false)
    ]);
  } catch (error) {
    console.log(error);
  };
  const issues = issueInfo.concat(prInfo);
  const repositories = generateRepoInfo(repoOwner, repoNames, issues);
  const result = {
    issues,
    repoLabels: labelInfo,
    repositories
  };
  const recentResult = {
    issues: filterRecent(issues),
    repoLabels: labelInfo,
    repositories
  };

  fs.writeFile(`${__dirname}/../issues.json`, JSON.stringify(result), err => {
    if (err) console.log(err);
  });

  fs.writeFile(
    `${__dirname}/../recent-issues.json`,
    JSON.stringify(recentResult),
    err => {
      if (err) console.log(err);
    }
  );

})();
