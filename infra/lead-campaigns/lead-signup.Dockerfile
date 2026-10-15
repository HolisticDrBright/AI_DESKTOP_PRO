# The sign-up service image. Built from dist/lead-campaigns/lead-signup (npm run build:lead-campaigns), which
# bundles src/lead-signup/ alone; the build refuses anything clinical. Not built or pushed by this repository:
# the native AWS owner builds it, mirrors it into the campaign account's ECR and deploys it by digest
# (campaigns-stack.json refuses an image that is not pinned by digest).
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /srv
COPY dist/lead-campaigns/lead-signup/server.mjs ./server.mjs
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
