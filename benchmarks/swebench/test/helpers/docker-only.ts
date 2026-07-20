import { test } from "bun:test";

export const inDockerTest = process.env.DUET_TEST_IN_DOCKER === "1";

export const testIfDocker = inDockerTest ? test : test.skip;
