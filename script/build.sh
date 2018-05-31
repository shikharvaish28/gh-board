#!/bin/bash

set -e -x

npm run build
NODE_ENV=development npx babel-node --presets env --plugins transform-class-properties script/fetch-issues.js
