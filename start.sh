#!/bin/sh

yarn --frozen-lockfile
pm2 start ./ecosystem.config.js