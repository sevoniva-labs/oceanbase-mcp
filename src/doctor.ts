#!/usr/bin/env node

import { runDoctorCommand } from "./doctor-runner.js";

process.exitCode = await runDoctorCommand(process.argv.slice(2));
