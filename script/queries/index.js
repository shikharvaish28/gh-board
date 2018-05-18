const fs = require('fs');
const loadQuery = name =>
  fs.readFileSync(`${__dirname}/${name}.graphql`).toString();

module.exports.GITHUB_ISSUE_INFO_QUERY = loadQuery('github_issue_info');
module.exports.GITHUB_PR_INFO_QUERY = loadQuery('github_pr_info');
module.exports.GITHUB_LABEL_INFO_QUERY = loadQuery('github_label_info');
module.exports.GITHUB_REACTION_INFO_QUERY = loadQuery('github_reaction_info');
