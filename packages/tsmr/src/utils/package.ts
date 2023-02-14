import fs from 'node:fs'
import path from 'node:path'

import { findWorkspacePackages } from '@pnpm/find-workspace-packages'
import { getProjectDir } from 'lion-utils'
import onetime from 'onetime'
import { pkgUpSync } from 'pkg-up'
import invariant from 'tiny-invariant'
import { type PackageJson } from 'type-fest'

export const getMonorepoDir = onetime(() =>
	getProjectDir(process.cwd(), { monorepoRoot: true })
)

export const getPackageSlugCategories = onetime(async () => {
	const monorepoDir = getMonorepoDir()
	const workspacePackages = await findWorkspacePackages(monorepoDir)
	const packageSlugCategories: Record<string, string[]> = {}
	for (const workspacePackage of workspacePackages) {
		invariant(workspacePackage.manifest.name !== undefined)
		const packageSlug = workspacePackage.manifest.name.split('/').at(-1)
		invariant(packageSlug !== undefined)
		packageSlugCategories[path.relative(monorepoDir, workspacePackage.dir)] ??=
			[]
		packageSlugCategories[
			path.relative(monorepoDir, workspacePackage.dir)
		]!.push(packageSlug)
	}

	return packageSlugCategories
})

export const getPackageSlugs = onetime(async () => {
	const packageSlugCategories = await getPackageSlugCategories()
	return Object.keys(packageSlugCategories)
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
	const packageSlugToCategoryMap = await getPackageSlugToCategoryMap()
	const packageCategory = packageSlugToCategoryMap[packageSlug]
	invariant(packageCategory !== undefined)
	const monorepoDir = getMonorepoDir()
	return path.join(monorepoDir, packageCategory, packageSlug)
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
