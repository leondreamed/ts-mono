import { type Buffer } from 'node:buffer'

import { execa } from 'execa'
import splitLines from 'split-lines'
import stripAnsi from 'strip-ansi'
import invariant from 'tiny-invariant'

import { getTsmrConfig } from '~/utils/config.js'

import { getMonorepoDir } from './package.js'

/**
	A wrapper around turbo typecheck that adds an any type to modules without a `node_modules` folder
*/
export async function turboTypecheck({
	logs,
	turboArguments,
}: {
	logs: 'full' | 'summary' | 'none'
	turboArguments?: string[]
}): Promise<{ exitCode: number }> {
	const monorepoDir = getMonorepoDir()
	const tsmrConfig = await getTsmrConfig()
	const turboArgs = Array.isArray(tsmrConfig.turboArgs)
		? tsmrConfig.turboArgs
		: tsmrConfig.turboArgs?.typecheck ?? []
	turboArgs.push(...(turboArguments ?? []))

	console.info('Typechecking with Turbo...')
	// Run `tsc` (without `--build` on all packages first, ignoring any errors)
	const turboProcess = execa(
		'pnpm',
		['exec', 'turbo', 'typecheck', ...turboArgs],
		{
			cwd: monorepoDir,
			stdio: 'pipe',
			reject: false,
			env: {
				FORCE_COLOR: '3',
			},
		}
	)
	invariant(turboProcess.stdout !== null, 'stdout is not null')

	const bufferedLogLines: string[] = []
	/**
		For easier debugging, we only log the lines that have errors
	*/
	turboProcess.stdout.on('data', (dataBuffer: Buffer) => {
		const dataLines = splitLines(dataBuffer.toString())
		for (let [lineIndex, line] of dataLines.entries()) {
			if (lineIndex < dataLines.length - 1) {
				line += '\n'
			}

			// We ignore the lines emitted by pnpm
			const strippedAnsiLine = stripAnsi(line)
			// Match the part after the Turbo prefix
			const lineContents = /^@dialect-inc\/[\da-z-]+:\w+:(.*)/.exec(
				strippedAnsiLine
			)?.[1]
			if (lineContents === undefined) {
				process.stdout.write(line)
				continue
			}

			if (lineContents.startsWith(' > ')) {
				continue
			}

			if (logs === 'full') {
				process.stdout.write(line)
			}

			bufferedLogLines.push(line)
		}
	})

	const { exitCode } = await turboProcess
	if (logs === 'summary' && exitCode !== 0) {
		process.stdout.write(bufferedLogLines.join(''))
	}

	console.info('Finished typechecking with Turbo!')
	return { exitCode }
}

export async function turboLint({
	logs,
	onlyShowErrors = false,
	turboArguments,
}: {
	logs: 'full' | 'summary' | 'none'
	onlyShowErrors: boolean
	turboArguments?: string[]
}): Promise<{ exitCode: number }> {
	const monorepoDir = getMonorepoDir()
	const tsmrConfig = await getTsmrConfig()
	const turboArgs = Array.isArray(tsmrConfig.turboArgs)
		? tsmrConfig.turboArgs
		: tsmrConfig.turboArgs?.lint ?? []
	turboArgs.push(...(turboArguments ?? []))

	const pnpmArgs = ['exec', 'turbo', 'lint', ...turboArgs, '--']

	if (onlyShowErrors) {
		pnpmArgs.push('--quiet')
	}

	console.info('Linting with Turbo...')
	const turboProcess = execa('pnpm', pnpmArgs, {
		cwd: monorepoDir,
		stdio: 'pipe',
		reject: false,
		env: {
			FORCE_COLOR: '3',
		},
	})
	invariant(turboProcess.stdout !== null, 'stdout is not null')

	const bufferedLogLines: string[] = []
	turboProcess.stdout.on('data', (dataBuffer: Buffer) => {
		const dataLines = splitLines(dataBuffer.toString())
		for (let [lineIndex, line] of dataLines.entries()) {
			if (lineIndex < dataLines.length - 1) {
				line += '\n'
			}

			if (logs === 'full') {
				process.stdout.write(line)
			}

			bufferedLogLines.push(line)
		}
	})

	const { exitCode } = await turboProcess

	if (exitCode !== 0 && logs === 'summary') {
		process.stdout.write(bufferedLogLines.join(''))
	}

	console.info('Finished linting with Turbo!')

	return { exitCode }
}
