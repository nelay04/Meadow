# Meadow load and performance run

- **commit** `0d4fbec`
- **when** 2026-09-10T11:08:21+00:00
- **host** Linux-6.18.33.1-microsoft-standard-WSL2-x86_64-with-glibc2.43, 4 logical CPUs, Python 3.14.4
- **target** http://127.0.0.1:8099, 1 uvicorn worker, rate limiting off
- **wall** 471.7s

Load generator and server share this machine, so both compete for the same cores. Latencies are therefore pessimistic and throughput is a floor, not a ceiling.

## Headline numbers

| what | measured |
|---|---|
| Concurrent sockets per board | **50** accepted, the next refused with close 4429 (as configured) |
| 10 editors, paced | 19.9 writes/s, 0 lost, converged: True |
| 25 editors, paced | 49.9 writes/s, 0 lost, converged: True |
| 5 editors, paced | 10.0 writes/s, 0 lost, converged: True |
| 50 editors, paced | 99.6 writes/s, 0 lost, converged: True |
| Update ingest ceiling | **586.1 updates/s** sustained (4777.0/s offered, 71.52s to drain, 0 lost) |
| Cursor propagation, 10 peers | p50 **2.379 ms**, p95 **3.191 ms**, p99 3.763 ms, delivery 1.0 |
| Cursor propagation, 25 peers | p50 **4.013 ms**, p95 **5.505 ms**, p99 7.333 ms, delivery 1.0 |
| Cursor propagation, 5 peers | p50 **1.921 ms**, p95 **2.532 ms**, p99 3.119 ms, delivery 1.0 |
| Cursor propagation, 50 peers | p50 **6.283 ms**, p95 **8.107 ms**, p99 9.516 ms, delivery 1.0 |
| Compaction, 2000 updates (churn) | 15678.9 updates/s, 2000 rows -> 0, 1.32x bytes |
| Compaction, 2000 updates (all-new-objects) | 8979.3 updates/s, 2000 rows -> 0, 1.15x bytes |
| Compaction, 5000 updates (churn) | 10159.7 updates/s, 5000 rows -> 0, 1.32x bytes |
| Compaction, 500 updates (all-new-objects) | 3347.1 updates/s, 500 rows -> 0, 1.15x bytes |
| REST reads, 16 clients | 175.5 req/s, 0 errors |
| REST reads, 32 clients | 217.3 req/s, 0 errors |
| REST reads, 64 clients | 227.2 req/s, 0 errors |
| REST reads, 8 clients | 258.7 req/s, 0 errors |
| Handshake refusal under load | every bad token refused: **True**, valid token still accepted: True |

## Per-operation latency

### REST reads, 8 concurrent clients

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| GET /boards | 974 | 0 | 64.7 | 36.068 | 68.772 | 171.471 | 249.986 |
| GET /boards/{id} | 974 | 0 | 64.7 | 24.457 | 41.674 | 108.861 | 155.929 |
| GET /auth/me | 974 | 0 | 64.7 | 24.604 | 41.653 | 88.051 | 146.743 |
| GET /boards/{id}/members | 974 | 0 | 64.7 | 24.512 | 45.23 | 106.734 | 157.133 |

### REST reads, 16 concurrent clients

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| GET /boards | 665 | 0 | 43.9 | 88.157 | 264.534 | 365.468 | 566.11 |
| GET /boards/{id} | 665 | 0 | 43.9 | 66.246 | 223.914 | 286.111 | 452.892 |
| GET /auth/me | 665 | 0 | 43.9 | 65.357 | 204.79 | 254.379 | 308.424 |
| GET /boards/{id}/members | 665 | 0 | 43.9 | 63.997 | 213.421 | 266.495 | 317.93 |

### REST reads, 32 concurrent clients

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| GET /boards | 833 | 0 | 54.3 | 151.232 | 311.729 | 476.072 | 531.707 |
| GET /boards/{id} | 833 | 0 | 54.3 | 122.49 | 266.542 | 326.565 | 386.624 |
| GET /auth/me | 833 | 0 | 54.3 | 122.556 | 239.642 | 296.411 | 310.914 |
| GET /boards/{id}/members | 833 | 0 | 54.3 | 124.356 | 238.216 | 307.344 | 344.158 |

### REST reads, 64 concurrent clients

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| GET /boards | 888 | 0 | 56.8 | 282.007 | 488.656 | 687.779 | 746.223 |
| GET /boards/{id} | 888 | 0 | 56.8 | 268.433 | 400.091 | 456.024 | 549.008 |
| GET /auth/me | 888 | 0 | 56.8 | 261.128 | 385.358 | 448.025 | 562.916 |
| GET /boards/{id}/members | 888 | 0 | 56.8 | 255.547 | 391.922 | 474.023 | 554.082 |

### Login throughput (argon2id bound)

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| POST /auth/login | 145 | 0 | 9.3 | 1639.377 | 2816.803 | 3370.259 | 3482.851 |

### 5 concurrent editors, paced at 2 edits/s each

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| ws connect | 5 | 0 | 79.4 | 11.635 | 17.834 | 17.834 | 17.834 |
| ws write | 200 | 0 | 10.0 | 0.146 | 0.661 | 0.756 | 3.537 |

### 10 concurrent editors, paced at 2 edits/s each

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| ws connect | 10 | 0 | 73.5 | 12.989 | 19.034 | 19.034 | 19.034 |
| ws write | 400 | 0 | 19.9 | 0.114 | 0.563 | 0.782 | 2.035 |

### 25 concurrent editors, paced at 2 edits/s each

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| ws connect | 25 | 0 | 96.4 | 9.796 | 14.141 | 19.364 | 19.364 |
| ws write | 1000 | 0 | 49.9 | 0.104 | 0.248 | 0.599 | 1.107 |

### 50 concurrent editors, paced at 2 edits/s each

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| ws connect | 50 | 0 | 89.9 | 10.875 | 13.116 | 15.551 | 15.551 |
| ws write | 2000 | 0 | 99.6 | 0.108 | 0.345 | 0.612 | 10.238 |

### 10 editors, unpaced (finds the ingest ceiling)

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| ws connect | 10 | 0 | 72.9 | 12.486 | 22.245 | 22.245 | 22.245 |
| ws write | 47783 | 0 | 4777.0 | 0.121 | 0.314 | 0.519 | 14.342 |

### Cursor propagation, 5 peers in the room

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| cursor propagation | 780 | 0 | 67.8 | 1.921 | 2.532 | 3.119 | 3.52 |

### Cursor propagation, 10 peers in the room

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| cursor propagation | 1755 | 0 | 152.9 | 2.379 | 3.191 | 3.763 | 6.807 |

### Cursor propagation, 25 peers in the room

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| cursor propagation | 4680 | 0 | 407.0 | 4.013 | 5.505 | 7.333 | 8.744 |

### Cursor propagation, 50 peers in the room

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| cursor propagation | 9506 | 0 | 829.4 | 6.283 | 8.107 | 9.516 | 13.316 |

### Compaction: 500 updates

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| ws write | 500 | 0 | 23869.1 | 0.031 | 0.086 | 0.178 | 0.724 |

### Compaction: 2000 updates

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| ws write | 2000 | 0 | 16069.9 | 0.039 | 0.153 | 0.219 | 2.785 |

### Compaction: 2000 updates over 50 objects

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| ws write | 2000 | 0 | 13916.5 | 0.043 | 0.175 | 0.36 | 2.264 |

### Compaction: 5000 updates over 25 objects

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| ws write | 5000 | 0 | 10589.3 | 0.077 | 0.197 | 0.343 | 1.393 |

### Reconnect storm (every client of a board at once)

| operation | ok | err | rate/s | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| POST /ws-token | 150 | 0 | 50.1 | 365.668 | 595.679 | 646.923 | 654.206 |
| ws handshake (storm) | 150 | 0 | 50.1 | 135.368 | 463.265 | 552.703 | 560.875 |


## Raw

```json
{
  "rest_reads_c8": {
    "concurrency": 8,
    "duration_s": 15.06,
    "requests": 3896,
    "errors": 0,
    "requests_per_s": 258.7,
    "series": [
      {
        "name": "GET /boards",
        "unit": "ms",
        "count": 974,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.061,
        "throughput_per_s": 64.7,
        "min": 21.802,
        "p50": 36.068,
        "p95": 68.772,
        "p99": 171.471,
        "max": 249.986,
        "mean": 41.748
      },
      {
        "name": "GET /boards/{id}",
        "unit": "ms",
        "count": 974,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.061,
        "throughput_per_s": 64.7,
        "min": 11.949,
        "p50": 24.457,
        "p95": 41.674,
        "p99": 108.861,
        "max": 155.929,
        "mean": 27.162
      },
      {
        "name": "GET /auth/me",
        "unit": "ms",
        "count": 974,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.061,
        "throughput_per_s": 64.7,
        "min": 12.249,
        "p50": 24.604,
        "p95": 41.653,
        "p99": 88.051,
        "max": 146.743,
        "mean": 27.044
      },
      {
        "name": "GET /boards/{id}/members",
        "unit": "ms",
        "count": 974,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.061,
        "throughput_per_s": 64.7,
        "min": 10.128,
        "p50": 24.512,
        "p95": 45.23,
        "p99": 106.734,
        "max": 157.133,
        "mean": 27.474
      }
    ]
  },
  "rest_reads_c16": {
    "concurrency": 16,
    "duration_s": 15.16,
    "requests": 2660,
    "errors": 0,
    "requests_per_s": 175.5,
    "series": [
      {
        "name": "GET /boards",
        "unit": "ms",
        "count": 665,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.16,
        "throughput_per_s": 43.9,
        "min": 34.243,
        "p50": 88.157,
        "p95": 264.534,
        "p99": 365.468,
        "max": 566.11,
        "mean": 111.634
      },
      {
        "name": "GET /boards/{id}",
        "unit": "ms",
        "count": 665,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.16,
        "throughput_per_s": 43.9,
        "min": 15.629,
        "p50": 66.246,
        "p95": 223.914,
        "p99": 286.111,
        "max": 452.892,
        "mean": 86.611
      },
      {
        "name": "GET /auth/me",
        "unit": "ms",
        "count": 665,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.16,
        "throughput_per_s": 43.9,
        "min": 13.842,
        "p50": 65.357,
        "p95": 204.79,
        "p99": 254.379,
        "max": 308.424,
        "mean": 83.006
      },
      {
        "name": "GET /boards/{id}/members",
        "unit": "ms",
        "count": 665,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.16,
        "throughput_per_s": 43.9,
        "min": 11.119,
        "p50": 63.997,
        "p95": 213.421,
        "p99": 266.495,
        "max": 317.93,
        "mean": 81.64
      }
    ]
  },
  "rest_reads_c32": {
    "concurrency": 32,
    "duration_s": 15.33,
    "requests": 3332,
    "errors": 0,
    "requests_per_s": 217.3,
    "series": [
      {
        "name": "GET /boards",
        "unit": "ms",
        "count": 833,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.332,
        "throughput_per_s": 54.3,
        "min": 60.892,
        "p50": 151.232,
        "p95": 311.729,
        "p99": 476.072,
        "max": 531.707,
        "mean": 170.396
      },
      {
        "name": "GET /boards/{id}",
        "unit": "ms",
        "count": 833,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.332,
        "throughput_per_s": 54.3,
        "min": 34.465,
        "p50": 122.49,
        "p95": 266.542,
        "p99": 326.565,
        "max": 386.624,
        "mean": 137.793
      },
      {
        "name": "GET /auth/me",
        "unit": "ms",
        "count": 833,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.332,
        "throughput_per_s": 54.3,
        "min": 42.883,
        "p50": 122.556,
        "p95": 239.642,
        "p99": 296.411,
        "max": 310.914,
        "mean": 137.8
      },
      {
        "name": "GET /boards/{id}/members",
        "unit": "ms",
        "count": 833,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.332,
        "throughput_per_s": 54.3,
        "min": 10.137,
        "p50": 124.356,
        "p95": 238.216,
        "p99": 307.344,
        "max": 344.158,
        "mean": 136.614
      }
    ]
  },
  "rest_reads_c64": {
    "concurrency": 64,
    "duration_s": 15.63,
    "requests": 3552,
    "errors": 0,
    "requests_per_s": 227.2,
    "series": [
      {
        "name": "GET /boards",
        "unit": "ms",
        "count": 888,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.635,
        "throughput_per_s": 56.8,
        "min": 72.683,
        "p50": 282.007,
        "p95": 488.656,
        "p99": 687.779,
        "max": 746.223,
        "mean": 303.346
      },
      {
        "name": "GET /boards/{id}",
        "unit": "ms",
        "count": 888,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.635,
        "throughput_per_s": 56.8,
        "min": 89.247,
        "p50": 268.433,
        "p95": 400.091,
        "p99": 456.024,
        "max": 549.008,
        "mean": 275.423
      },
      {
        "name": "GET /auth/me",
        "unit": "ms",
        "count": 888,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.635,
        "throughput_per_s": 56.8,
        "min": 42.751,
        "p50": 261.128,
        "p95": 385.358,
        "p99": 448.025,
        "max": 562.916,
        "mean": 268.139
      },
      {
        "name": "GET /boards/{id}/members",
        "unit": "ms",
        "count": 888,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.635,
        "throughput_per_s": 56.8,
        "min": 34.257,
        "p50": 255.547,
        "p95": 391.922,
        "p99": 474.023,
        "max": 554.082,
        "mean": 263.186
      }
    ]
  },
  "auth_logins": {
    "concurrency": 16,
    "duration_s": 15.61,
    "series": [
      {
        "name": "POST /auth/login",
        "unit": "ms",
        "count": 145,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 15.606,
        "throughput_per_s": 9.3,
        "min": 722.891,
        "p50": 1639.377,
        "p95": 2816.803,
        "p99": 3370.259,
        "max": 3482.851,
        "mean": 1703.314
      }
    ]
  },
  "room_cap": {
    "configured_cap": 50,
    "sockets_accepted": 50,
    "overflow_close_code": 4429,
    "refused_correctly": true
  },
  "editors_paced_5": {
    "editors": 5,
    "duration_s": 20.06,
    "mode": "paced",
    "target_edits_per_s": 10.0,
    "writes_issued": 200,
    "offered_writes_per_s": 10.0,
    "ingest_writes_per_s": 9.0,
    "settle_s": 2.26,
    "update_bytes_sent": 17700,
    "objects_on_server": 200,
    "converged": true,
    "lost_updates": 0,
    "fanout_messages_received": 1011,
    "series": [
      {
        "name": "ws connect",
        "unit": "ms",
        "count": 5,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 0.063,
        "throughput_per_s": 79.4,
        "min": 10.634,
        "p50": 11.635,
        "p95": 17.834,
        "p99": 17.834,
        "max": 17.834,
        "mean": 12.584
      },
      {
        "name": "ws write",
        "unit": "ms",
        "count": 200,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 20.065,
        "throughput_per_s": 10.0,
        "min": 0.052,
        "p50": 0.146,
        "p95": 0.661,
        "p99": 0.756,
        "max": 3.537,
        "mean": 0.245
      }
    ]
  },
  "editors_paced_10": {
    "editors": 10,
    "duration_s": 20.08,
    "mode": "paced",
    "target_edits_per_s": 20.0,
    "writes_issued": 400,
    "offered_writes_per_s": 19.9,
    "ingest_writes_per_s": 17.9,
    "settle_s": 2.26,
    "update_bytes_sent": 35400,
    "objects_on_server": 400,
    "converged": true,
    "lost_updates": 0,
    "fanout_messages_received": 4021,
    "series": [
      {
        "name": "ws connect",
        "unit": "ms",
        "count": 10,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 0.136,
        "throughput_per_s": 73.5,
        "min": 11.191,
        "p50": 12.989,
        "p95": 19.034,
        "p99": 19.034,
        "max": 19.034,
        "mean": 13.609
      },
      {
        "name": "ws write",
        "unit": "ms",
        "count": 400,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 20.076,
        "throughput_per_s": 19.9,
        "min": 0.049,
        "p50": 0.114,
        "p95": 0.563,
        "p99": 0.782,
        "max": 2.035,
        "mean": 0.166
      }
    ]
  },
  "editors_paced_25": {
    "editors": 25,
    "duration_s": 20.06,
    "mode": "paced",
    "target_edits_per_s": 50.0,
    "writes_issued": 1000,
    "offered_writes_per_s": 49.9,
    "ingest_writes_per_s": 44.8,
    "settle_s": 2.26,
    "update_bytes_sent": 89620,
    "objects_on_server": 1000,
    "converged": true,
    "lost_updates": 0,
    "fanout_messages_received": 25059,
    "series": [
      {
        "name": "ws connect",
        "unit": "ms",
        "count": 25,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 0.259,
        "throughput_per_s": 96.4,
        "min": 8.359,
        "p50": 9.796,
        "p95": 14.141,
        "p99": 19.364,
        "max": 19.364,
        "mean": 10.375
      },
      {
        "name": "ws write",
        "unit": "ms",
        "count": 1000,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 20.058,
        "throughput_per_s": 49.9,
        "min": 0.047,
        "p50": 0.104,
        "p95": 0.248,
        "p99": 0.599,
        "max": 1.107,
        "mean": 0.127
      }
    ]
  },
  "editors_paced_50": {
    "editors": 50,
    "duration_s": 20.08,
    "mode": "paced",
    "target_edits_per_s": 100.0,
    "writes_issued": 2000,
    "offered_writes_per_s": 99.6,
    "ingest_writes_per_s": 89.5,
    "settle_s": 2.26,
    "update_bytes_sent": 180160,
    "objects_on_server": 2000,
    "converged": true,
    "lost_updates": 0,
    "fanout_messages_received": 100133,
    "series": [
      {
        "name": "ws connect",
        "unit": "ms",
        "count": 50,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 0.556,
        "throughput_per_s": 89.9,
        "min": 8.806,
        "p50": 10.875,
        "p95": 13.116,
        "p99": 15.551,
        "max": 15.551,
        "mean": 11.127
      },
      {
        "name": "ws write",
        "unit": "ms",
        "count": 2000,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 20.082,
        "throughput_per_s": 99.6,
        "min": 0.04,
        "p50": 0.108,
        "p95": 0.345,
        "p99": 0.612,
        "max": 10.238,
        "mean": 0.147
      }
    ]
  },
  "editors_saturation_10": {
    "editors": 10,
    "duration_s": 10.0,
    "mode": "saturation",
    "target_edits_per_s": null,
    "writes_issued": 47783,
    "offered_writes_per_s": 4777.0,
    "ingest_writes_per_s": 586.1,
    "settle_s": 71.52,
    "update_bytes_sent": 4427950,
    "objects_on_server": 47783,
    "converged": true,
    "lost_updates": 0,
    "fanout_messages_received": 32453,
    "series": [
      {
        "name": "ws connect",
        "unit": "ms",
        "count": 10,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 0.137,
        "throughput_per_s": 72.9,
        "min": 11.463,
        "p50": 12.486,
        "p95": 22.245,
        "p99": 22.245,
        "max": 22.245,
        "mean": 13.71
      },
      {
        "name": "ws write",
        "unit": "ms",
        "count": 47783,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 10.003,
        "throughput_per_s": 4777.0,
        "min": 0.031,
        "p50": 0.121,
        "p95": 0.314,
        "p99": 0.519,
        "max": 14.342,
        "mean": 0.147
      }
    ]
  },
  "cursors_5": {
    "peers": 5,
    "watchers": 4,
    "moves_sent": 195,
    "moves_per_s": 20.0,
    "receipts_expected": 780,
    "receipts_observed": 780,
    "delivery_ratio": 1.0,
    "series": [
      {
        "name": "cursor propagation",
        "unit": "ms",
        "count": 780,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 11.499,
        "throughput_per_s": 67.8,
        "min": 1.212,
        "p50": 1.921,
        "p95": 2.532,
        "p99": 3.119,
        "max": 3.52,
        "mean": 1.963
      }
    ]
  },
  "cursors_10": {
    "peers": 10,
    "watchers": 9,
    "moves_sent": 195,
    "moves_per_s": 20.0,
    "receipts_expected": 1755,
    "receipts_observed": 1755,
    "delivery_ratio": 1.0,
    "series": [
      {
        "name": "cursor propagation",
        "unit": "ms",
        "count": 1755,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 11.477,
        "throughput_per_s": 152.9,
        "min": 1.136,
        "p50": 2.379,
        "p95": 3.191,
        "p99": 3.763,
        "max": 6.807,
        "mean": 2.411
      }
    ]
  },
  "cursors_25": {
    "peers": 25,
    "watchers": 24,
    "moves_sent": 195,
    "moves_per_s": 20.0,
    "receipts_expected": 4680,
    "receipts_observed": 4680,
    "delivery_ratio": 1.0,
    "series": [
      {
        "name": "cursor propagation",
        "unit": "ms",
        "count": 4680,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 11.498,
        "throughput_per_s": 407.0,
        "min": 2.19,
        "p50": 4.013,
        "p95": 5.505,
        "p99": 7.333,
        "max": 8.744,
        "mean": 4.097
      }
    ]
  },
  "cursors_50": {
    "peers": 50,
    "watchers": 49,
    "moves_sent": 194,
    "moves_per_s": 20.0,
    "receipts_expected": 9506,
    "receipts_observed": 9506,
    "delivery_ratio": 1.0,
    "series": [
      {
        "name": "cursor propagation",
        "unit": "ms",
        "count": 9506,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 11.461,
        "throughput_per_s": 829.4,
        "min": 3.389,
        "p50": 6.283,
        "p95": 8.107,
        "p99": 9.516,
        "max": 13.316,
        "mean": 6.251
      }
    ]
  },
  "compaction_500_new": {
    "updates_written": 500,
    "distinct_objects": 500,
    "regime": "all-new-objects",
    "write_wall_s": 0.02,
    "log_rows_before": 500,
    "log_bytes_before": 48179,
    "rows_folded": 500,
    "fold_s": 0.149,
    "fold_updates_per_s": 3347.1,
    "log_rows_after": 0,
    "log_bytes_after": 0,
    "snapshot_rows_after": 1,
    "snapshot_bytes_after": 41820,
    "total_bytes_before": 48179,
    "total_bytes_after": 41820,
    "compression_ratio": 1.15,
    "bytes_reclaimed": 6359,
    "idempotent": true,
    "repeat_fold_s": 0.004,
    "series": [
      {
        "name": "ws write",
        "unit": "ms",
        "count": 500,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 0.021,
        "throughput_per_s": 23869.1,
        "min": 0.027,
        "p50": 0.031,
        "p95": 0.086,
        "p99": 0.178,
        "max": 0.724,
        "mean": 0.042
      }
    ]
  },
  "compaction_2000_new": {
    "updates_written": 2000,
    "distinct_objects": 2000,
    "regime": "all-new-objects",
    "write_wall_s": 0.12,
    "log_rows_before": 2000,
    "log_bytes_before": 194634,
    "rows_folded": 2000,
    "fold_s": 0.223,
    "fold_updates_per_s": 8979.3,
    "log_rows_after": 0,
    "log_bytes_after": 0,
    "snapshot_rows_after": 1,
    "snapshot_bytes_after": 168775,
    "total_bytes_before": 194634,
    "total_bytes_after": 168775,
    "compression_ratio": 1.15,
    "bytes_reclaimed": 25859,
    "idempotent": true,
    "repeat_fold_s": 0.005,
    "series": [
      {
        "name": "ws write",
        "unit": "ms",
        "count": 2000,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 0.124,
        "throughput_per_s": 16069.9,
        "min": 0.027,
        "p50": 0.039,
        "p95": 0.153,
        "p99": 0.219,
        "max": 2.785,
        "mean": 0.062
      }
    ]
  },
  "compaction_2000_50": {
    "updates_written": 2000,
    "distinct_objects": 50,
    "regime": "churn",
    "write_wall_s": 0.14,
    "log_rows_before": 2000,
    "log_bytes_before": 203178,
    "rows_folded": 2000,
    "fold_s": 0.128,
    "fold_updates_per_s": 15678.9,
    "log_rows_after": 0,
    "log_bytes_after": 0,
    "snapshot_rows_after": 1,
    "snapshot_bytes_after": 154059,
    "total_bytes_before": 203178,
    "total_bytes_after": 154059,
    "compression_ratio": 1.32,
    "bytes_reclaimed": 49119,
    "idempotent": true,
    "repeat_fold_s": 0.005,
    "series": [
      {
        "name": "ws write",
        "unit": "ms",
        "count": 2000,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 0.144,
        "throughput_per_s": 13916.5,
        "min": 0.028,
        "p50": 0.043,
        "p95": 0.175,
        "p99": 0.36,
        "max": 2.264,
        "mean": 0.071
      }
    ]
  },
  "compaction_5000_25": {
    "updates_written": 5000,
    "distinct_objects": 25,
    "regime": "churn",
    "write_wall_s": 0.47,
    "log_rows_before": 5000,
    "log_bytes_before": 509099,
    "rows_folded": 5000,
    "fold_s": 0.492,
    "fold_updates_per_s": 10159.7,
    "log_rows_after": 0,
    "log_bytes_after": 0,
    "snapshot_rows_after": 1,
    "snapshot_bytes_after": 384680,
    "total_bytes_before": 509099,
    "total_bytes_after": 384680,
    "compression_ratio": 1.32,
    "bytes_reclaimed": 124419,
    "idempotent": true,
    "repeat_fold_s": 0.004,
    "series": [
      {
        "name": "ws write",
        "unit": "ms",
        "count": 5000,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 0.472,
        "throughput_per_s": 10589.3,
        "min": 0.029,
        "p50": 0.077,
        "p95": 0.197,
        "p99": 0.343,
        "max": 1.393,
        "mean": 0.094
      }
    ]
  },
  "reconnect_storm": {
    "clients": 30,
    "rounds": 5,
    "handshakes": 150,
    "failures": 0,
    "series": [
      {
        "name": "POST /ws-token",
        "unit": "ms",
        "count": 150,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 2.993,
        "throughput_per_s": 50.1,
        "min": 34.621,
        "p50": 365.668,
        "p95": 595.679,
        "p99": 646.923,
        "max": 654.206,
        "mean": 326.856
      },
      {
        "name": "ws handshake (storm)",
        "unit": "ms",
        "count": 150,
        "errors": 0,
        "error_detail": {},
        "error_rate": 0.0,
        "elapsed_s": 2.993,
        "throughput_per_s": 50.1,
        "min": 9.54,
        "p50": 135.368,
        "p95": 463.265,
        "p99": 552.703,
        "max": 560.875,
        "mean": 190.052
      }
    ]
  },
  "refusal_under_load": {
    "cases": {
      "forged token": {
        "attempts": 10,
        "accepted": 0,
        "codes": [
          4401
        ],
        "all_refused": true
      },
      "empty token": {
        "attempts": 10,
        "accepted": 0,
        "codes": [
          4401
        ],
        "all_refused": true
      },
      "token for another board": {
        "attempts": 10,
        "accepted": 0,
        "codes": [
          4403
        ],
        "all_refused": true
      },
      "tampered signature": {
        "attempts": 10,
        "accepted": 0,
        "codes": [
          4401
        ],
        "all_refused": true
      },
      "valid token (control)": {
        "attempts": 1,
        "accepted": 1,
        "codes": [],
        "all_refused": false
      }
    },
    "every_bad_token_refused": true,
    "valid_token_still_accepted": true
  }
}
```
