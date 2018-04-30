const fs = require('fs');
const moment = require('moment');
const GraphQL = require('graphql-client');

const {
  GITHUB_ISSUE_INFO_QUERY,
  GITHUB_PR_INFO_QUERY,
  GITHUB_LABEL_INFO_QUERY
} = require('./queries');

const GH_GQL_BASE = 'https://api.github.com/graphql';
const GH_GQL_OPTIONS = {
  url: GH_GQL_BASE,
  headers: process.env.GITHUB_TOKEN
    ? { Authorization: `bearer ${process.env.GITHUB_TOKEN}` }
    : {}
};

const client = GraphQL(GH_GQL_OPTIONS);

// number of pages we want to query (default: 20 pages x 100 items)
// if PAGE_THRESHOLD is -1, then fetch all issues/PRs
const pageThreshold = process.env.PAGE_THRESHOLD || 20;
console.log('page number threshold:', pageThreshold);

const repo = process.env.REPOSITORIES;

if (!repo) {
  console.log('No repositories to cache. Skipping.');
  process.exit();
}

const repoOwner = repo.split(':')[0];
const repoNames = repo.substring(repo.indexOf(':') + 1).split('|');

console.log('Fetching issues data for', repoOwner, repoNames);

const getTime = timeString => moment(timeString).toDate().getTime();

async function fetchNextPage(owner, name, isIssue, data, cursor, pageCount) {
  // fetch data of next page
  console.log('owner:', owner, 'name:', name, 'isIssue:', isIssue,
    'cursor:', cursor, 'page count:', pageCount);

  let nextData = null, hasPreviousPage = false;
  pageCount++;
  try {
    if (isIssue) {
      ({ data: nextData } = await client.query(
        GITHUB_ISSUE_INFO_QUERY,
        {owner, name, before: cursor}
      ));
    } else {
      ({ data: nextData } = await client.query(
        GITHUB_PR_INFO_QUERY,
        {owner, name, before: cursor}
      ));
    }
  } catch (error) {
    console.log('owner:', owner, 'name:', name, 'isIssue:', isIssue,
      'cursor:', cursor, 'error:', error);
  }
  if (nextData && nextData.repository) {
    let nodes = [];
    if (isIssue) {
      ({ nodes, pageInfo } = nextData.repository.issues);
    } else {
      ({ nodes, pageInfo } = nextData.repository.pullRequests);
    }
    cursor = pageInfo.startCursor;
    hasPreviousPage = pageInfo.hasPreviousPage;
    const result = nodes.map(node => {
      let user, assignee, milestone;

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
        assignee = {
          login: null,
          avatarUrl: null
        };
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
        info.pullRequest = {
          htmlUrl: node.url
        };
      }
      return info;
    });
    data = data.concat(result);
    if (hasPreviousPage && (pageCount < pageThreshold || pageThreshold == -1)) {
      return fetchNextPage(owner, name, isIssue, data,
        cursor, pageCount);
    } else {
      return data;
    }
  } else {
    console.log('Warning: no available data. owner:', owner, 'name:', name,
      'isIssue:', isIssue, 'pageCount:', pageCount);
    return data;
  }
}

async function fetchIssue(owner, names, isIssue) {
  let result = [];
  for (const name of names) {
    try {
      result = result.concat(
        await fetchNextPage(owner, name, isIssue, [], null, 0));
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

;(async () => {
  let issueInfo, prInfo, labelInfo;
  try {
    // Don't fetch them concurrently, otherwise some queries may fail 
    issueInfo = await fetchIssue(repoOwner, repoNames, true);
    prInfo = await fetchIssue(repoOwner, repoNames, false); 
    labelInfo = await fetchLabel(repoOwner, repoNames); 
  } catch (error) {
    console.log(error);
  };
  const issues = issueInfo.concat(prInfo);
  const result = {
    issues: issues,
    repoLabels: labelInfo,
    repositories: generateRepoInfo(repoOwner, repoNames, issues)
  };

  fs.writeFile(`${__dirname}/../issues.json`, JSON.stringify(result), err => {
    if (err) console.log(err);
  });
})();
