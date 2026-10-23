# S3-compatible object storage for the Document service, for hosts that run one
# container per service (e.g. Render). Credentials come from S3_ACCESS_KEY /
# S3_SECRET_KEY at startup instead of a mounted s3.json; data lives on /data
# (attach a persistent disk there).
FROM chrislusf/seaweedfs:4.48
COPY entrypoint.sh /entrypoint-uboce.sh
RUN chmod +x /entrypoint-uboce.sh
EXPOSE 8333
ENTRYPOINT ["/entrypoint-uboce.sh"]
