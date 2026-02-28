#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:3000}"
WEB_BASE_URL="${WEB_BASE_URL:-http://127.0.0.1:3001}"
CURL_TIMEOUT_SECONDS="${CURL_TIMEOUT_SECONDS:-15}"

PASS_COUNT=0
FAIL_COUNT=0

contains_status() {
  local got="$1"
  local expected_csv="$2"
  case ",$expected_csv," in
    *",$got,"*) return 0 ;;
    *) return 1 ;;
  esac
}

record_pass() {
  local name="$1"
  printf '[PASS] %s\n' "$name"
  PASS_COUNT=$((PASS_COUNT + 1))
}

record_fail() {
  local name="$1"
  local expected="$2"
  local got="$3"
  local body_file="$4"
  printf '[FAIL] %s (expected: %s, got: %s)\n' "$name" "$expected" "$got"
  if [[ -s "$body_file" ]]; then
    printf -- '--- response body ---\n'
    cat "$body_file"
    printf -- '\n---------------------\n'
  fi
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

check_http() {
  local name="$1"
  local expected_csv="$2"
  local method="$3"
  local url="$4"
  shift 4

  local body
  body="$(mktemp)"
  local status

  if ! status="$(curl -sS -m "$CURL_TIMEOUT_SECONDS" -o "$body" -w '%{http_code}' -X "$method" "$url" "$@")"; then
    printf '[FAIL] %s (curl request failed)\n' "$name"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    rm -f "$body"
    return
  fi

  if contains_status "$status" "$expected_csv"; then
    record_pass "$name"
  else
    record_fail "$name" "$expected_csv" "$status" "$body"
  fi

  rm -f "$body"
}

check_contains() {
  local name="$1"
  local method="$2"
  local url="$3"
  local needle="$4"
  shift 4

  local body
  body="$(mktemp)"
  local status

  if ! status="$(curl -sS -m "$CURL_TIMEOUT_SECONDS" -o "$body" -w '%{http_code}' -X "$method" "$url" "$@")"; then
    printf '[FAIL] %s (curl request failed)\n' "$name"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    rm -f "$body"
    return
  fi

  if [[ "$status" == "200" ]] && grep -Fq "$needle" "$body"; then
    record_pass "$name"
  else
    printf '[FAIL] %s (expected status 200 and body containing %s, got status %s)\n' "$name" "$needle" "$status"
    if [[ -s "$body" ]]; then
      printf -- '--- response body ---\n'
      cat "$body"
      printf -- '\n---------------------\n'
    fi
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi

  rm -f "$body"
}

check_dashboard_redirect() {
  local name="WEB /dashboard redirects to /login when unauthenticated"
  local header_file
  local body_file
  header_file="$(mktemp)"
  body_file="$(mktemp)"

  local status
  if ! status="$(curl -sS -m "$CURL_TIMEOUT_SECONDS" -D "$header_file" -o "$body_file" -w '%{http_code}' "$WEB_BASE_URL/dashboard")"; then
    printf '[FAIL] %s (curl request failed)\n' "$name"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    rm -f "$header_file" "$body_file"
    return
  fi

  local location
  location="$(awk 'BEGIN{IGNORECASE=1} /^location:/ {print $2}' "$header_file" | tr -d '\r' | head -n1)"

  if contains_status "$status" "302,307,308" && [[ "$location" == *"/login"* ]]; then
    record_pass "$name"
  else
    printf '[FAIL] %s (expected 302/307/308 + location /login, got %s + %s)\n' "$name" "$status" "${location:-<empty>}"
    if [[ -s "$body_file" ]]; then
      printf -- '--- response body ---\n'
      cat "$body_file"
      printf -- '\n---------------------\n'
    fi
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi

  rm -f "$header_file" "$body_file"
}

printf 'Running functional regression checks...\n'
printf 'API_BASE_URL=%s\n' "$API_BASE_URL"
printf 'WEB_BASE_URL=%s\n\n' "$WEB_BASE_URL"

# API baseline
check_http "API /health" "200" "GET" "$API_BASE_URL/health"
check_contains "API /health body contains ok" "GET" "$API_BASE_URL/health" '"ok":true'
check_http "API /metrics" "200" "GET" "$API_BASE_URL/metrics"
check_http "API /github/health" "200" "GET" "$API_BASE_URL/github/health"
check_http "API /gitlab/health" "200" "GET" "$API_BASE_URL/gitlab/health"
check_http "API /webhook/events unauth/disabled" "400,403" "GET" "$API_BASE_URL/webhook/events"

# Web baseline
check_http "WEB /api/health" "200" "GET" "$WEB_BASE_URL/api/health"
check_http "WEB /" "200" "GET" "$WEB_BASE_URL/"
check_http "WEB /login" "200" "GET" "$WEB_BASE_URL/login"
check_dashboard_redirect

# Auth + billing route behavior when unauthenticated
check_http "WEB POST /api/stripe/checkout unauth" "401" "POST" "$WEB_BASE_URL/api/stripe/checkout" \
  -H 'content-type: application/json' \
  --data '{"planId":"pro","organizationId":"org_test"}'
check_http "WEB POST /api/stripe/portal unauth" "401" "POST" "$WEB_BASE_URL/api/stripe/portal" \
  -H 'content-type: application/json' \
  --data '{"organizationId":"org_test"}'

printf '\nSummary: pass=%d fail=%d\n' "$PASS_COUNT" "$FAIL_COUNT"

if [[ "$FAIL_COUNT" -ne 0 ]]; then
  exit 1
fi
