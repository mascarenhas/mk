FROM nickblah/lua:5.3.5-luarocks-alpine

ENV PORT 8080

WORKDIR /app

RUN apk --no-cache add \
  openssl \
  && apk --no-cache add --virtual build-deps \
  bsd-compat-headers \
  build-base \
  m4 \
  cmake \
  git \
  unzip \
  openssl-dev \
  && luarocks install http \
  && apk del build-deps

ADD *.lua ./
ADD mk mk
ADD test test

EXPOSE ${PORT}

CMD ["lua", "server.lua"]
