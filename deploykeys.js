const hostPattern = '[a-z0-9-]+(?:\\.[a-z0-9-]+)+';

// Repository URL in a key comment: `git@<host>:<path>`, `https://<host>/<path>` or
// `ssh://git@<host>[:<port>]/<path>`, where <host> contains a dot and <path> has at least two
// segments (e.g. owner/repo or group/subgroup/repo)
const repositoryUrlPattern = new RegExp(
    `\\b(?:git@(${hostPattern}):|https://(${hostPattern})/|ssh://git@(${hostPattern})(?::(\\d+))?/)`
    + '([_.a-z0-9-]+(?:/[_.a-z0-9-]+)+)',
    'i'
);

// Path suffixes of web pages within a repository, e.g. https://github.com/owner/repo/tree/main
// or https://gitlab.com/group/repo/-/tree/main
const webPageSuffix = /\/(?:-|tree|blob|commits?|pulls?|issues|merge_requests)(?:\/.*)?$/;

// Returns { host, port, repoPath } for the repository named in a key comment, or null
function parseKeyComment(comment) {
    const parts = comment.match(repositoryUrlPattern);

    if (!parts) {
        return null;
    }

    return {
        host: (parts[1] || parts[2] || parts[3]).toLowerCase(),
        port: parts[4],
        repoPath: parts[5].replace(webPageSuffix, '').replace(/\.git$/, ''),
    };
}

// URLs of the repository that git rewrites to the deploy key's ssh Host alias
function repositoryUrls({ host, port, repoPath }) {
    const urls = [`https://${host}/${repoPath}`, `git@${host}:${repoPath}`, `ssh://git@${host}/${repoPath}`];

    if (port) {
        urls.push(`ssh://git@${host}:${port}/${repoPath}`);
    }

    return urls;
}

module.exports = { parseKeyComment, repositoryUrls };
