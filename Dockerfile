FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS builder

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG APP_EDITION=clinical
ARG APP_RUNTIME_ENV=staging
ARG NEXT_PUBLIC_APP_ENV=staging
ARG NEXT_PUBLIC_USE_LIVE_API=true
ARG CLINICAL_DATA_PLANE=supabase_staging
ARG CLINICAL_SUPABASE_URL
ARG CLINICAL_AWS_REGION=us-east-2
ARG CLINICAL_AWS_API_ORIGIN
ARG CLINICAL_AWS_ALLOWED_API_HOSTS
ARG CLINICAL_AWS_RUNTIME_MODE=synthetic
ENV APP_EDITION=$APP_EDITION \
    APP_RUNTIME_ENV=$APP_RUNTIME_ENV \
    NEXT_PUBLIC_APP_ENV=$NEXT_PUBLIC_APP_ENV \
    NEXT_PUBLIC_USE_LIVE_API=$NEXT_PUBLIC_USE_LIVE_API \
    CLINICAL_DATA_PLANE=$CLINICAL_DATA_PLANE \
    CLINICAL_SUPABASE_URL=$CLINICAL_SUPABASE_URL \
    CLINICAL_AWS_REGION=$CLINICAL_AWS_REGION \
    CLINICAL_AWS_API_ORIGIN=$CLINICAL_AWS_API_ORIGIN \
    CLINICAL_AWS_ALLOWED_API_HOSTS=$CLINICAL_AWS_ALLOWED_API_HOSTS \
    CLINICAL_AWS_RUNTIME_MODE=$CLINICAL_AWS_RUNTIME_MODE
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN CLINICAL_SUPABASE_ANON_KEY=build-time-placeholder npm run build

FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
