FROM eclipse-temurin:17-jre-jammy

RUN apt-get update && apt-get install -y \
    nginx wget curl gettext-base ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG OPENREFINE_VERSION=3.9.5
ENV OPENREFINE_VERSION=${OPENREFINE_VERSION}

RUN wget -q "https://github.com/OpenRefine/OpenRefine/releases/download/${OPENREFINE_VERSION}/openrefine-linux-${OPENREFINE_VERSION}.tar.gz" \
    -O /tmp/openrefine.tar.gz \
    && mkdir -p /opt/openrefine \
    && tar -xzf /tmp/openrefine.tar.gz --strip-components=1 -C /opt/openrefine \
    && rm /tmp/openrefine.tar.gz \
    && chmod +x /opt/openrefine/refine

RUN mkdir -p /data && chmod 777 /data

COPY nginx.conf /etc/nginx/nginx.conf.template
COPY entrypoint.sh /entrypoint.sh
COPY healthcheck.sh /healthcheck.sh
RUN chmod +x /entrypoint.sh /healthcheck.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD /healthcheck.sh

ENTRYPOINT ["/entrypoint.sh"]
