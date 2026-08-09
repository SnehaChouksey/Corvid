# Corvid

An autonomous security agent that finds, tests, and verifies web app vulnerabilities like a real pentester, with proof for every finding.

## What it does

Corvid tests authorized web applications the way a human tester would. It looks for likely weak spots, runs a real test against them, and only reports a finding after it has proven the issue actually works. No guessing, and no long list of false alarms to sort through.

## Why it is different

Most scanners match patterns and hand you a pile of maybes. Corvid does the reasoning part itself, then backs up every result with a repeatable proof. If it cannot prove a finding is real, it does not report it.

## Principles

- Verify, never guess. A finding is only reported once a check confirms it fires.
- Humans approve active steps. Anything that sends a live test payload waits for sign off.
- Runs in a sandbox with locked down network access.
- Every action is logged with who, when, and what.
- No target is touched without recorded authorization.

## Status

Early development. The first version focuses on a small set of vulnerability classes done well rather than broad, shallow coverage.

## Authorization

Corvid is for authorized testing only. Do not point it at anything you do not have explicit permission to test.
