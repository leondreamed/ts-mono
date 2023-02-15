import fs from 'node:fs'
import path from 'node:path'

import {
	type Project,
	findWorkspacePackages,
} from '@pnpm/find-workspace-packages'
import { getProjectDir } from 'lion-utils'
import onetime from 'onetime'
import { pkgUpSync } from 'pkg-up'
import invariant from 'tiny-invariant'
import { type PackageJson } from 'type-fest'

export const getMonorepoDir = onetime(() =>
	getProjectDir(process.cwd(), { monorepoRoot: true })
)

export const getPackageSlug = ({ packageName }: { packageName: string }) =>
	packageName.split('/').at(-1)!

export const getWorkspacePackageSlugsMap = onetime(async () => {
	const monorepoDir = getMonorepoDir()
	const workspacePackageSlugsMap: Record<string, Project> = {}
	const workspacePackages = await findWorkspacePackages(monorepoDir)
	for (const workspacePackage of workspacePackages) {
		const packageName = workspacePackage.manifest.name
		invariant(
			packageName,
			`package at ${workspacePackage.dir} must have a name`
		)
		const packageSlug = getPackageSlug({ packageName })
		workspacePackageSlugsMap[packageSlug] = workspacePackage
	}

	return workspacePackageSlugsMap
})

export const getPackageSlugCategories = onetime(async () => {
	const monorepoDir = getMonorepoDir()
	const workspacePackageSlugsMap = await getWorkspacePackageSlugsMap()

	const packageSlugCategories: Record<string, string[]> = {}
	for (const [packageSlug, workspacePackage] of Object.entries(
		workspacePackageSlugsMap
	)) {
		const packageCategory = path.dirname(
			path.relative(monorepoDir, workspacePackage.dir)
		)

		packageSlugCategories[packageCategory] ??= []
		packageSlugCategories[packageCategory]!.push(packageSlug)
	}

	return packageSlugCategories
})

export const getPackageSlugs = onetime(async () => {
	const workspacePackageSlugsMap = await getWorkspacePackageSlugsMap()
	return Object.keys(workspacePackageSlugsMap)
})

export const getPackageSlugToCategoryMap = onetime(async () => {
	const packageSlugCategories = await getPackageSlugCategories()
	return Object.fromEntries(
		Object.entries(packageSlugCategories).flatMap(([category, packageSlugs]) =>
			packageSlugs.map((packageSlug) => [packageSlug, category])
		)
	)
})

export async function getPackageDir({ packageSlug }: { packageSlug: string }) {
	const workspacePackageSlugsMap = await getWorkspacePackageSlugsMap()
	const workspacePackage = workspacePackageSlugsMap[packageSlug]
	invariant(workspacePackage !== undefined, `package ${packageSlug} not found`)
	return workspacePackage.dir
}

export async function getPackageJson({ packageSlug }: { packageSlug: string }) {
	const packageDir = await getPackageDir({ packageSlug })
	const packageJson = JSON.parse(
		await fs.promises.readFile(path.join(packageDir, 'package.json'), 'utf8')
	) as PackageJson

	return packageJson
}

export async function shouldPackageBeChecked({
	packageSlug,
}: {
	packageSlug: string
}): Promise<boolean> {
	const packageDir = await getPackageDir({ packageSlug })
	const nodeModulesPath = path.join(packageDir, 'node_modules')
	const metadataPath = path.join(nodeModulesPath, 'metadata.json')
	if (!fs.existsSync(nodeModulesPath)) return false
	if (fs.existsSync(metadataPath)) {
		const metadata = JSON.parse(
			await fs.promises.readFile(metadataPath, 'utf8')
		) as { ignoreScripts?: boolean }
		if (metadata.ignoreScripts) {
			return false
		}
	}

	return true
}

export function inferPackageSlugFromPath(path: string) {
	pkgUpSync({
		cwd: path,
	})
}
