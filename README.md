# MicroKepler reboot

Proof of concept for what a micro-framework based on https://github.com/daurnimator/lua-http
looks like, optimized for small Docker image sizes and deployment on "serverless" container
systems like Google Cloud Run and AWS Fargate or Kubernetes pods.

Sample service in `samples/service.lua` deployed to Cloud Run on https://mkpoc-master-h646osnt4a-ue.a.run.app
using Github Actions.
