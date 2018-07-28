export const GITHUB_LABEL_INFO_QUERY = `
  query($owner: String!, $name: String!) {
    rateLimit {
      limit
      remaining
      resetAt
    }
    repository(owner:$owner, name:$name) {
      labels(first:100){
        nodes {
          id
          url
          name
          color
          isDefault
        }
      }
    }
  }`;
