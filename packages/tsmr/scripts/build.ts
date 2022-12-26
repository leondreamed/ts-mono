import { rmDist, tsc, copyPackageFiles } from 'lionconfig'

rmDist()
await tsc()
await copyPackageFiles()