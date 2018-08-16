# Chlu Infrastructure

This project has a pm2 configuration file that configures and starts [Chlu](https://chlu.io) services.

## Full Setup

- copy `.env.example` to `.env` and fill in the required secret keys and configuration options
  - if you want your marketplace to be accessible from the internet and your payment-backed reviews to be validatable,
  then fill in the CHLU_MARKETPLACE_LOCATION to the internet-reachable URL of your Chlu Marketplace
- make sure all projects are running on the same Chlu Network
- set up your local Wallet and login as a user with some test bitcoins. [Follow instructions on Wallet docs](https://github.com/ChluNetwork/chlu-wallet#test--demo)
- make sure you have `pm2` installed
- start the infrastructure with `bash start.sh`
- start your [Wallet](https://github.com/ChluNetwork/chlu-wallet)
- you have a full Chlu environment set up now. Use `pm2` commands with `ecosystem.config.js` to manage the services