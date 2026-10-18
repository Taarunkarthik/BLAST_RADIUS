# BlastRadius

A local-first CLI that reports broken files and traces how JavaScript and TypeScript failures propagate through a repository.

Implementation is in progress against the v3.0 product requirements. The first milestone is the complete diagnostic CLI: discovery, six checker families, dependency graphs, impact paths, deterministic reports, and CI exit codes.

The scanner is read-only. It does not execute project code or contact the network.
