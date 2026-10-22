const { execFileSync } = require('child_process');
const crypto = require('crypto');

// Names of the `url.<base>.insteadOf` keys of deploy-key rewrites, as written by this action and
// webfactory/ssh-agent. git prints these names with `url` and `insteadof` in lowercase, so the
// pattern's source also works as a case-sensitive git regex.
const deployKeyInsteadOfPattern = /^url\.git@key-[0-9a-f]{64}\..*\.insteadof$/i;

// git 2.31 is the first version that reads config from GIT_CONFIG_COUNT/KEY_<n>/VALUE_<n>
const minGitVersion = [2, 31];

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

// Names derived from a public key (an `ssh-add -L` line): the file holding it in ~/.ssh and the
// ssh Host alias that git connects to for the repository on `host`
function deployKeyNames(publicKey, host) {
    const keyFile = `key-${crypto.createHash('sha256').update(publicKey).digest('hex')}`;
    return { keyFile, alias: `${keyFile}.${host}` };
}

// URLs of the repository that git rewrites to the deploy key's ssh Host alias
function repositoryUrls({ host, port, repoPath }) {
    const urls = [`https://${host}/${repoPath}`, `git@${host}:${repoPath}`, `ssh://git@${host}/${repoPath}`];

    if (port) {
        urls.push(`ssh://git@${host}:${port}/${repoPath}`);
    }

    return urls;
}

// Git config entries that rewrite the repository's URLs to the ssh Host alias `alias`
function rewriteEntries(alias, repository) {
    const key = `url.git@${alias}:${repository.repoPath}.insteadOf`;
    return repositoryUrls(repository).map(url => ({ key, value: url }));
}

function withoutDeployKeyRewrites(entries) {
    return entries.filter(entry => !deployKeyInsteadOfPattern.test(entry.key));
}

// Whether `git --version` output is at least minGitVersion
function supportsConfigEnv(versionOutput) {
    const [major, minor] = (versionOutput.match(/(\d+)\.(\d+)/) || []).slice(1).map(Number);
    return major > minGitVersion[0] || (major === minGitVersion[0] && minor >= minGitVersion[1]);
}

function checkGitVersion(gitCmd) {
    const version = execFileSync(gitCmd, ['--version']).toString().trim();

    if (!supportsConfigEnv(version)) {
        throw new Error(`Deploy keys need git ${minGitVersion.join('.')} or later, found '${version}'`);
    }
}

function globalGitConfig(gitCmd, args) {
    // LC_ALL=C keeps git's error messages in English
    return execFileSync(gitCmd, ['config', '--global', ...args], { stdio: 'pipe', env: { ...process.env, LC_ALL: 'C' } }).toString();
}

// Lists the sections of the deploy-key rewrites in the global git config
function listGlobalDeployKeySections(gitCmd) {
    let output;

    try {
        output = globalGitConfig(gitCmd, ['--name-only', '--get-regexp', deployKeyInsteadOfPattern.source]);
    } catch (error) {
        // `git config --get-regexp` exits with status 1 when nothing matches
        if (error.status === 1) {
            return [];
        }
        throw error;
    }

    const sections = output.split(/\r?\n/).filter(Boolean).map(name => name.replace(/\.insteadof$/, ''));

    return [...new Set(sections)];
}

function removeSections(gitCmd, sections) {
    sections.forEach(function(section) {
        try {
            globalGitConfig(gitCmd, ['--remove-section', section]);
            console.log(`Removed git config section ${section}`);
        } catch (error) {
            // Another git process can remove the section first
            if (!String(error.stderr).includes('no such section')) {
                throw error;
            }
        }
    });
}

// Removes all deploy-key rewrites from the global git config. Other jobs leave them there when
// $HOME is shared between jobs, pointing to ssh Host aliases that may no longer exist, and git
// prefers them over equally long rewrites set in the environment.
function removeGlobalDeployKeyRewrites(gitCmd) {
    removeSections(gitCmd, listGlobalDeployKeySections(gitCmd));
}

// Reads the git config entries set through GIT_CONFIG_COUNT, GIT_CONFIG_KEY_<n> and
// GIT_CONFIG_VALUE_<n> as { key, value } pairs
function parseConfigEnv(env) {
    const count = parseInt(env.GIT_CONFIG_COUNT || '0', 10);

    return Array.from({ length: count }, (_, i) => ({ key: env[`GIT_CONFIG_KEY_${i}`], value: env[`GIT_CONFIG_VALUE_${i}`] }));
}

function formatConfigEnv(entries) {
    const env = { GIT_CONFIG_COUNT: String(entries.length) };

    entries.forEach(function({ key, value }, i) {
        env[`GIT_CONFIG_KEY_${i}`] = key;
        env[`GIT_CONFIG_VALUE_${i}`] = value;
    });

    return env;
}

module.exports = {
    deployKeyInsteadOfPattern,
    parseKeyComment,
    deployKeyNames,
    repositoryUrls,
    rewriteEntries,
    withoutDeployKeyRewrites,
    supportsConfigEnv,
    checkGitVersion,
    listGlobalDeployKeySections,
    removeSections,
    removeGlobalDeployKeyRewrites,
    parseConfigEnv,
    formatConfigEnv,
};
