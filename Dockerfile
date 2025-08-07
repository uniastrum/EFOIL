# syntax = docker/dockerfile:1

ARG NODE_VERSION=18.16.0
FROM node:${NODE_VERSION}-slim AS base

WORKDIR /app
ENV NODE_ENV=production

FROM base AS build

RUN apt-get update -qq && apt-get install -y python-is-python3 pkg-config build-essential

COPY package.json package-lock.json ./
RUN npm install --production

COPY . .

FROM base

COPY --from=build /app /app

EXPOSE 8080

CMD ["npm", "run", "start"]
