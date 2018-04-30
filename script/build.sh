#!/bin/bash

npm run build
node ./script/fetch-issues.js
