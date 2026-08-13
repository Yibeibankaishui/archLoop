---
"@yibeibankaishui/archloop": patch
---

Ship one Hub task through a durable fenced local landing transaction onto a Hub-managed publish target. Publication stays off by default, the user's checkout is left untouched, and `shipped` is derived from the verified candidate plus matching task-close metadata.
