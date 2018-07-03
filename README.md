# Chlu Infrastructure

This project has a pm2 configuration file that configures and starts [Chlu](https://chlu.io) services.

## Full Setup

- copy `.env.example` to `.env` and fill in the required secret keys
- make sure your `marketplace-config.json` is correct ([Marketplace Docs](https://github.com/ChluNetwork/chlu-marketplace-js))
- make sure all projects are running on the same Chlu Network
- set up your local Wallet and login as a user with some test bitcoins. [Follow instructions on Wallet docs](https://github.com/ChluNetwork/chlu-wallet#test--demo)
- start the infrastructure with `pm2 start ecosystem.config.js` and then start your [Wallet](https://github.com/ChluNetwork/chlu-wallet)
- you have a full Chlu environment set up now