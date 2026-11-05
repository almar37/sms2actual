#!/bin/sh
set -eu

image_name="${ACTUAL_SMS_SETUP_IMAGE:-actual-sms-setup:local}"
actual_host="${ACTUAL_SMS_ACTUAL_HOST:-}"
setup_network="${ACTUAL_SMS_SETUP_NETWORK:-}"

docker build -t "$image_name" .

if [ -t 0 ] && [ -t 1 ]; then
  terminal_args="-it"
else
  terminal_args="-i"
fi

# The CLI executes from the production image so Actual's native SQLite module
# matches its Node runtime. The host project is mounted only as the output path.
run_container() {
  if [ -n "$setup_network" ]; then
    docker run --rm $terminal_args --network "$setup_network" \
      --user "$(id -u):$(id -g)" "$@"
  else
    docker run --rm $terminal_args --user "$(id -u):$(id -g)" "$@"
  fi
}

if [ -n "$actual_host" ]; then
  run_container --add-host "$actual_host" \
    --volume "$PWD:/setup-output" --workdir /setup-output \
    --entrypoint tini "$image_name" -- node /app/dist/setup.js "$@"
else
  run_container \
    --volume "$PWD:/setup-output" --workdir /setup-output \
    --entrypoint tini "$image_name" -- node /app/dist/setup.js "$@"
fi
