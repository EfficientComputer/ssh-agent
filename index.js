const core = require('@actions/core');
const child_process = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { homePath, sshAgentCmd, sshAddCmd, gitCmd } = require('./paths.js');
const { parseKeyComment, repositoryUrls } = require('./deploykeys.js');

try {
    const privateKey = core.getInput('ssh-private-key');
    const logPublicKey = core.getBooleanInput('log-public-key', {default: true});

    if (!privateKey) {
        core.setFailed("The ssh-private-key argument is empty. Maybe the secret has not been configured, or you are using a wrong secret name in your workflow file.");

        return;
    }

    const homeSsh = homePath + '/.ssh';
    fs.mkdirSync(homeSsh, { recursive: true });

    console.log("Starting ssh-agent");

    const authSock = core.getInput('ssh-auth-sock');
    const sshAgentArgs = (authSock && authSock.length > 0) ? ['-a', authSock] : [];

    // Extract auth socket path and agent pid and set them as job variables
    child_process.execFileSync(sshAgentCmd, sshAgentArgs).toString().split("\n").forEach(function(line) {
        const matches = /^(SSH_AUTH_SOCK|SSH_AGENT_PID)=(.*); export \1/.exec(line);

        if (matches && matches.length > 0) {
            // This will also set process.env accordingly, so changes take effect for this script
            core.exportVariable(matches[1], matches[2])
            console.log(`${matches[1]}=${matches[2]}`);
        }
    });

    console.log("Adding private key(s) to agent");

    privateKey.split(/(?=-----BEGIN)/).forEach(function(key) {
        child_process.execFileSync(sshAddCmd, ['-'], { input: key.trim() + "\n" });
    });

    console.log("Key(s) added:");

    child_process.execFileSync(sshAddCmd, ['-l'], { stdio: 'inherit' });

    console.log('Configuring deployment key(s)');

    child_process.execFileSync(sshAddCmd, ['-L']).toString().trim().split(/\r?\n/).forEach(function(key) {
        // `ssh-add -L` prints "<type> <base64 key> <comment>"; only the comment names the repository
        const comment = key.split(' ').slice(2).join(' ');
        const repository = parseKeyComment(comment);

        if (!repository) {
            if (logPublicKey) {
              console.log(`Comment for (public) key '${key}' does not contain a repository URL. Not treating it as a deploy key.`);
            }
            return;
        }

        const sha256 = crypto.createHash('sha256').update(key).digest('hex');
        const alias = `key-${sha256}.${repository.host}`;

        fs.writeFileSync(`${homeSsh}/key-${sha256}`, key + "\n", { mode: '600' });

        const section = `url.git@${alias}:${repository.repoPath}`;

        repositoryUrls(repository).forEach(function(url, index) {
            child_process.execFileSync(gitCmd, ['config', '--global', index == 0 ? '--replace-all' : '--add', `${section}.insteadOf`, url]);
        });

        const sshConfig = `\nHost ${alias}\n`
                              + `    HostName ${repository.host}\n`
                              + (repository.port ? `    Port ${repository.port}\n` : '')
                              + `    IdentityFile ${homeSsh}/key-${sha256}\n`
                              + `    IdentitiesOnly yes\n`;

        fs.appendFileSync(`${homeSsh}/config`, sshConfig);

        console.log(`Added deploy-key mapping: Use identity '${homeSsh}/key-${sha256}' for ${repository.host} repository ${repository.repoPath}`);
    });

} catch (error) {

    if (error.code == 'ENOENT') {
        console.log(`The '${error.path}' executable could not be found. Please make sure it is on your PATH and/or the necessary packages are installed.`);
        console.log(`PATH is set to: ${process.env.PATH}`);
    }

    core.setFailed(error.message);
}
