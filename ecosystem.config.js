// PM2 Ecosystem File

const path = require('path')

function projectPath(s) {
    return path.join('node_modules', s)
}

const home = process.env.HOME

module.exports = {
    /**
     * Application configuration section
     * http://pm2.keymetrics.io/docs/usage/application-declaration/
     */
    apps: [
        {
            name: 'chlu-marketplace',
            script: projectPath('chlu-marketplace-js/src/bin/index.js'),
            watch: false,
            args: 'serve -c marketplace-config.json',
            max_memory_restart: '250M'
        },
        {
            name: 'chlu-service-node',
            script: projectPath('chlu-ipfs-support/bin/chlu-service-node.js'),
            watch: false,
            // This is running on the master branch and does not require additional CLI params
            args: 'start --network staging',
            max_memory_restart: '250M'
        },
        {
            name: 'rendezvous',
            script: projectPath('libp2p-websocket-star-rendezvous/src/bin.js'),
            watch: false,
            args: '--port=4003',
            max_memory_restart: '250M'
        },
        {
            name: 'chlu-reputation-service-node',
            script: projectPath('chlu-reputation-service-node/index.js'),
            watch: false,
            args: 'start',
            max_memory_restart: '250M'
        },
        {
            name: 'chlu-did-service',
            script: projectPath('chlu-did-service/index.js'),
            watch: false,
            args: '',
            max_memory_restart: '250M'
        }
    ],
};
