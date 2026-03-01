#!/usr/bin/env bash
set -euo pipefail

: "${AWS_PROFILE:=mfa}"
export AWS_PROFILE

CLUSTER="kai-somethings-production"
REGION="us-east-1"
LOCAL_PORT="${1:-5433}"

RDS_HOST=$(aws ssm get-parameter --name /kai/somethings/production/rds/endpoint --region "$REGION" --query 'Parameter.Value' --output text)
EC2_ID=$(aws ecs list-container-instances --cluster "$CLUSTER" --region "$REGION" --query 'containerInstanceArns[0]' --output text \
  | xargs -I{} aws ecs describe-container-instances --cluster "$CLUSTER" --container-instances {} --region "$REGION" --query 'containerInstances[0].ec2InstanceId' --output text)

echo "RDS:   $RDS_HOST"
echo "EC2:   $EC2_ID"
echo "Local: localhost:$LOCAL_PORT → RDS:5432"
echo ""
echo "Connect with: psql postgresql://kai@localhost:$LOCAL_PORT/kai"
echo "Press Ctrl+C to stop"
echo ""

aws ssm start-session \
  --target "$EC2_ID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$RDS_HOST\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}" \
  --region "$REGION"
