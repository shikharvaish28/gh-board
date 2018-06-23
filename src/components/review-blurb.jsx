import Database from '../database';
import Loadable from './loadable';

function ReviewBlurb({card: {url}}) {
  const reviewNumber = url.split('/').pop();

  return (
    <span className='review-blurb'>
      <a className='blurb-number-link'
        target='_blank'
        href={url}
        >
        <span className='blurb-number'>{reviewNumber}</span>
      </a>
    </span>
  );
}

function ReviewBlurbShell({card, primaryRepoName, context}) {
  const {repoOwner, repoName} = card;
  const promise = Database.getRepoOrNull(repoOwner, repoName);

  return (
    <Loadable
      promise={promise}
      renderLoaded={(repo) => (<ReviewBlurb repo={repo} card={card} primaryRepoName={primaryRepoName} context={context} />)}
    />
  );
}

export default ReviewBlurbShell;
