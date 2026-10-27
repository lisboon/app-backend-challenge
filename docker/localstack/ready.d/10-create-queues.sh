#!/bin/bash
set -euo pipefail

dlq_url=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl --output text)

dlq_arn=$(awslocal sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

queue_url=$(awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl --output text)

awslocal sqs set-queue-attributes \
  --queue-url "$queue_url" \
  --attributes "{
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":\\\"10\\\"}\"
  }"

awslocal sqs create-queue \
  --queue-name "${EVENTS_QUEUE_NAME:-wallet-events.fifo}" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null
