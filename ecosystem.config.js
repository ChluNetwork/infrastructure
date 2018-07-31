// PM2 Ecosystem File

const path = require('path')
const env = require('node-env-file')

function projectPath(s) {
    return path.join('node_modules', s)
}

env(path.join(__dirname, '.env'))

const blockcypherToken = process.env.BLOCKCYPHER_TOKEN
const network = process.env.CHLU_NETWORK || 'experimental'

module.exports = {
    /**
     * Application configuration section
     * http://pm2.keymetrics.io/docs/usage/application-declaration/
     */
    apps: [
        // Low-level services necessary for Chlu ecosystem
        {
            name: 'rendezvous',
            script: projectPath('libp2p-websocket-star-rendezvous/src/bin.js'),
            watch: false,
            args: '--port=4003',
            max_memory_restart: '250M'
        },
        {
            name: 'chlu-collector',
            script: projectPath('chlu-collector/src/bin.js'),
            watch: false,
            args: `start --network ${network} ` + (blockcypherToken ? ` --btc ${blockcypherToken}` : ''),
            max_memory_restart: '250M'
        },
        // Mid-level services (API Gateways)
        {
            name: 'chlu-api-query',
            script: projectPath('chlu-api-query/src/bin.js'),
            watch: false,
            args: `start --network ${network} ` + (blockcypherToken ? ` --btc ${blockcypherToken}` : ''),
            max_memory_restart: '250M'
        },
        {
            name: 'chlu-api-publish',
            script: projectPath('chlu-api-publish/src/bin.js'),
            watch: false,
            args: `start --network ${network} ` + (blockcypherToken ? ` --btc ${blockcypherToken}` : ''),
            max_memory_restart: '250M'
        },
        // High-level services built on Chlu libraries
        {
            name: 'chlu-marketplace',
            script: projectPath('chlu-marketplace-js/src/bin/index.js'),
            watch: false,
            args: 'serve -c marketplace-config.json',
            max_memory_restart: '250M'
        },
        {
            name: 'chlu-did-service',
            script: projectPath('chlu-did-service/index.js'),
            watch: false,
            args: `start --network ${network}`,
            max_memory_restart: '250M'
        }
    ],
};
