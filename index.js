const core = require('@actions/core');
const child_process = require('child_process');
const fs = require('fs');
const { homePath, sshAgentCmd, sshAddCmd, gitCmd } = require('./paths.js');
const {
    parseKeyComment,
    deployKeyNames,
    rewriteEntries,
    withoutDeployKeyRewrites,
    checkGitVersion,
    removeGlobalDeployKeyRewrites,
    parseConfigEnv,
    formatConfigEnv,
} = require('./deploykeys.js');

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

    try {
        removeGlobalDeployKeyRewrites(gitCmd);
    } catch (error) {
        // The job's own rewrites don't depend on the global git config, so this is not fatal
        if (error.code == 'ENOENT') {
            console.log(`Not checking the global git config for deploy-key rewrites: '${error.path}' not found`);
        } else {
            core.warning(`Could not remove deploy-key rewrites from the global git config: ${error.message}`);
        }
    }

    console.log('Configuring deployment key(s)');

    // `ssh-add -L` prints "<type> <base64 key> <comment>"; only the comment names the repository
    const deployKeys = child_process.execFileSync(sshAddCmd, ['-L']).toString().trim().split(/\r?\n/).flatMap(function(publicKey) {
        const repository = parseKeyComment(publicKey.split(' ').slice(2).join(' '));

        if (!repository && logPublicKey) {
            console.log(`Comment for (public) key '${publicKey}' does not contain a repository URL. Not treating it as a deploy key.`);
        }

        return repository ? [{ publicKey, repository }] : [];
    });

    if (deployKeys.length > 0) {
        checkGitVersion(gitCmd);
    }

    // The rewrites go into the job's environment rather than the global git config, so that they
    // end with the job. Deploy-key rewrites from earlier invocations in the job are dropped: their
    // keys are in an ssh-agent that is no longer used.
    let gitConfigEntries = withoutDeployKeyRewrites(parseConfigEnv(process.env));
    const sshConfigFile = `${homeSsh}/config`;

    deployKeys.forEach(function({ publicKey, repository }) {
        const { keyFile, alias } = deployKeyNames(publicKey, repository.host);

        fs.writeFileSync(`${homeSsh}/${keyFile}`, publicKey + "\n", { mode: '600' });

        gitConfigEntries = gitConfigEntries.concat(rewriteEntries(alias, repository));

        // The Host block only depends on the key and host, so one from an earlier job can be reused
        const sshConfig = `\nHost ${alias}\n`
                              + `    HostName ${repository.host}\n`
                              + (repository.port ? `    Port ${repository.port}\n` : '')
                              + `    IdentityFile ${homeSsh}/${keyFile}\n`
                              + `    IdentitiesOnly yes\n`;

        if (!(fs.existsSync(sshConfigFile) && fs.readFileSync(sshConfigFile, 'utf8').includes(sshConfig))) {
            fs.appendFileSync(sshConfigFile, sshConfig);
        }

        console.log(`Added deploy-key mapping: Use identity '${homeSsh}/${keyFile}' for ${repository.host} repository ${repository.repoPath}`);
    });

    Object.entries(formatConfigEnv(gitConfigEntries)).forEach(([name, value]) => core.exportVariable(name, value));

} catch (error) {

    if (error.code == 'ENOENT') {
        console.log(`The '${error.path}' executable could not be found. Please make sure it is on your PATH and/or the necessary packages are installed.`);
        console.log(`PATH is set to: ${process.env.PATH}`);
    }

    core.setFailed(error.message);
}
