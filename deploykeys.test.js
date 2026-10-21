const test = require('node:test');
const assert = require('node:assert');
const { parseKeyComment, repositoryUrls } = require('./deploykeys.js');

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

test('repositoryUrls adds the ssh:// URL with the port', function() {
    assert.deepStrictEqual(repositoryUrls({ host: 'h.com', port: '2222', repoPath: 'o/r' }), [
        'https://h.com/o/r',
        'git@h.com:o/r',
        'ssh://git@h.com/o/r',
        'ssh://git@h.com:2222/o/r',
    ]);
});
