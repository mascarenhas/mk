FROM debian:buster as build

WORKDIR /build

RUN apt-get update && apt-get upgrade -y && apt-get install --no-install-recommends -y \
		curl \
		wget \
		build-essential \
		make \
        m4 \
        cmake \
		ca-certificates \
		unzip \
		libssl-dev \
		git

RUN wget http://www.lua.org/ftp/lua-5.3.5.tar.gz && \
    tar zxvf lua-5.3.5.tar.gz && \
    cd lua-5.3.5 && \
    make posix MYCFLAGS="-DLUA_USE_DLOPEN" MYLIBS="-Wl,-E -ldl" && \
    make install INSTALL_TOP=/lua && \
    cd .. && \
    wget https://luarocks.org/releases/luarocks-3.2.1.tar.gz && \
    tar zxpf luarocks-3.2.1.tar.gz && \
    cd luarocks-3.2.1 && \
    ./configure --prefix=/lua --lua-version=5.3 --with-lua=/lua --force-config && \
    make && make install && \
    /lua/bin/luarocks install lua-cjson 2.1.0 && \
    /lua/bin/luarocks install http

FROM gcr.io/distroless/base-debian10
COPY --from=build /lua /lua/

ADD src ./
ADD samples samples

ENV PORT 8080

ENV LUA_PATH "/lua/share/lua/5.3/?.lua;/lua/share/lua/5.3/?/init.lua;/lua/lib/lua/5.3/?.lua;/lua/lib/lua/5.3/?/init.lua;./?.lua;./?/init.lua"
ENV LUA_CPATH "/lua/lib/lua/5.3/?.so;/lua/lib/lua/5.3/loadall.so;./?.so"

EXPOSE ${PORT}

CMD ["/lua/bin/lua", "samples/service.lua"]
