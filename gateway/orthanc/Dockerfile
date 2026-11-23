# Orthanc as orthancteam/orthanc:24.12.0 ships it - the same Orthanc, plugins, viewer and start-up script - with the
# Debian 12 security updates its base has not had since. Every Orthanc this repository runs is built from this one
# file: the hospital gateway (which takes only the gateway/ folder) from ./orthanc, the central stack and the
# synthetic Query/Retrieve peer from ./gateway/orthanc. The reference is the one the licence inventory names.
FROM orthancteam/orthanc:24.12.0

# Over HTTPS, as everything else these hosts fetch.
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
 && rm -rf /var/lib/apt/lists/*
