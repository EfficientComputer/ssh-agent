const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    deployKeyInsteadOfPattern,
    parseKeyComment,
    deployKeyNames,
    repositoryUrls,
    rewriteEntries,
    withoutDeployKeyRewrites,
    supportsConfigEnv,
    listGlobalDeployKeySections,
    removeSections,
    removeGlobalDeployKeyRewrites,
    parseConfigEnv,
    formatConfigEnv,
} = require('./deploykeys.js');

const sha = c => c.repeat(64);
const repository = { host: 'github.com', repoPath: 'owner/repo' };

test('parseKeyComment', async function(t) {
    const github = repoPath => ({ host: 'github.com', port: undefined, repoPath });
    const cases = [
        ['git@github.com:owner/repo.git', github('owner/repo')],
        ['https://github.com/owner/repo', github('owner/repo')],
        ['ssh://git@github.com/owner/repo.git', github('owner/repo')],
        ['ssh://git@git.example.com:2222/owner/repo.git', { host: 'git.example.com', port: '2222', repoPath: 'owner/repo' }],
        ['git@gitlab.com:group/subgroup/repo.git', { host: 'gitlab.com', port: undefined, repoPath: 'group/subgroup/repo' }],
        ['deploy key for git@github.com:owner/repo.git', github('owner/repo')],
        ['git@GitHub.com:Owner/Repo.git', github('Owner/Repo')],
        ['https://github.com/owner/repo/tree/main', github('owner/repo')],
        ['https://github.com/owner/repo/blob/main/README.md', github('owner/repo')],
        ['https://gitlab.com/group/sub/repo/-/tree/main', { host: 'gitlab.com', port: undefined, repoPath: 'group/sub/repo' }],
        ['ci@runner', null],
        ['/home/user/.ssh/id_ed25519', null],
        ['ci/deploy/key', null],
        ['created 2024/01/05', null],
        ['git@localhost:owner/repo', null],
        ['github.com:owner/repo', null],
        ['', null],
    ];

    for (const [comment, expected] of cases) {
        await t.test(JSON.stringify(comment), function() {
            assert.deepStrictEqual(parseKeyComment(comment), expected);
        });
    }
});

test('deployKeyNames', function() {
    const publicKey = 'ssh-ed25519 AAAA git@github.com:owner/repo.git';
    const { keyFile, alias } = deployKeyNames(publicKey, 'github.com');

    assert.match(keyFile, /^key-[0-9a-f]{64}$/);
    assert.strictEqual(alias, `${keyFile}.github.com`);
    assert.deepStrictEqual(deployKeyNames(publicKey, 'github.com'), { keyFile, alias });
    assert.notStrictEqual(deployKeyNames(publicKey + 'x', 'github.com').keyFile, keyFile);
});

test('rewriteEntries', async function(t) {
    await t.test('rewrites each repository URL to the alias', function() {
        const alias = `key-${sha('a')}.github.com`;

        assert.deepStrictEqual(rewriteEntries(alias, repository), [
            { key: `url.git@${alias}:owner/repo.insteadOf`, value: 'https://github.com/owner/repo' },
            { key: `url.git@${alias}:owner/repo.insteadOf`, value: 'git@github.com:owner/repo' },
            { key: `url.git@${alias}:owner/repo.insteadOf`, value: 'ssh://git@github.com/owner/repo' },
        ]);
    });

    await t.test('adds the ssh:// URL with the port', function() {
        assert.deepStrictEqual(repositoryUrls({ host: 'h.com', port: '2222', repoPath: 'o/r' }), [
            'https://h.com/o/r',
            'git@h.com:o/r',
            'ssh://git@h.com/o/r',
            'ssh://git@h.com:2222/o/r',
        ]);
    });

    await t.test('produces keys that deployKeyInsteadOfPattern recognises', function() {
        const { alias } = deployKeyNames('ssh-ed25519 AAAA comment', 'git.example.com');

        rewriteEntries(alias, repository).forEach(entry => assert.match(entry.key, deployKeyInsteadOfPattern));
    });
});

test('withoutDeployKeyRewrites keeps everything but deploy-key rewrites', function() {
    const other = [
        { key: 'user.name', value: 'x' },
        { key: 'url.https://mirror.example.com/owner/repo.insteadOf', value: 'https://github.com/owner/repo' },
    ];
    const deployKey = c => rewriteEntries(`key-${sha(c)}.github.com`, repository);

    assert.deepStrictEqual(withoutDeployKeyRewrites([...deployKey('a'), ...other, ...deployKey('b')]), other);
});

test('supportsConfigEnv', function() {
    assert.strictEqual(supportsConfigEnv('git version 2.31.0'), true);
    assert.strictEqual(supportsConfigEnv('git version 2.52.0'), true);
    assert.strictEqual(supportsConfigEnv('git version 3.0.1'), true);
    assert.strictEqual(supportsConfigEnv('git version 2.47.1.windows.2'), true);
    assert.strictEqual(supportsConfigEnv('git version 2.30.2'), false);
    assert.strictEqual(supportsConfigEnv('git version 1.8.3.1'), false);
    assert.strictEqual(supportsConfigEnv('garbage'), false);
});

test('config env round-trips through parseConfigEnv and formatConfigEnv', function() {
    const entries = [{ key: 'user.name', value: 'x' }, { key: 'core.autocrlf', value: 'false' }];

    assert.deepStrictEqual(parseConfigEnv({}), []);
    assert.deepStrictEqual(parseConfigEnv(formatConfigEnv(entries)), entries);
});

test('git config', async function(t) {
    // Isolates git from the user's and system config, and from GIT_CONFIG_* set by the environment
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploykeys-'));
    const savedEnv = { ...process.env };
    Object.keys(process.env).filter(name => name.startsWith('GIT_CONFIG')).forEach(name => delete process.env[name]);
    Object.assign(process.env, {
        HOME: dir,
        XDG_CONFIG_HOME: dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'),
    });

    const git = (args, env = {}) => execFileSync('git', args, { env: { ...process.env, ...env } }).toString();
    const plant = c => git(['config', '--global', '--add', `url.git@key-${sha(c)}.github.com:owner/repo.insteadOf`, 'https://github.com/owner/repo']);
    // The URL git uses for https://github.com/owner/repo
    const resolved = (env = {}) => git(['ls-remote', '--get-url', 'https://github.com/owner/repo'], env).trim();
    const envWithRewrite = () => formatConfigEnv(rewriteEntries(`key-${sha('a')}.github.com`, repository));

    const subtest = (name, fn) => t.test(name, function() {
        fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
        fn();
    });

    try {
        await subtest('listGlobalDeployKeySections returns nothing for an empty config', function() {
            assert.deepStrictEqual(listGlobalDeployKeySections('git'), []);
        });

        await subtest('removeGlobalDeployKeyRewrites removes all deploy-key rewrites and keeps other config', function() {
            plant('b');
            plant('c');
            git(['config', '--global', '--add', 'url.git@github.com:.insteadOf', 'https://github.com/']);

            removeGlobalDeployKeyRewrites('git');

            assert.deepStrictEqual(listGlobalDeployKeySections('git'), []);
            assert.strictEqual(git(['config', '--global', '--get', 'url.git@github.com:.insteadOf']).trim(), 'https://github.com/');
        });

        await subtest('removeSections skips sections that are already gone', function() {
            plant('b');

            removeSections('git', ['url.git@key-gone.github.com:owner/repo', `url.git@key-${sha('b')}.github.com:owner/repo`]);

            assert.deepStrictEqual(listGlobalDeployKeySections('git'), []);
        });

        await subtest('git uses the rewrites from the environment', function() {
            assert.strictEqual(resolved(envWithRewrite()), `git@key-${sha('a')}.github.com:owner/repo`);
        });

        await subtest('an equally long global deploy-key rewrite takes precedence over the environment until removed', function() {
            plant('b');

            assert.strictEqual(resolved(envWithRewrite()), `git@key-${sha('b')}.github.com:owner/repo`);

            removeGlobalDeployKeyRewrites('git');

            assert.strictEqual(resolved(envWithRewrite()), `git@key-${sha('a')}.github.com:owner/repo`);
        });
    } finally {
        Object.keys(process.env).forEach(name => delete process.env[name]);
        Object.assign(process.env, savedEnv);
        fs.rmSync(dir, { recursive: true });
    }
});
