import { rmDist, tsc, copyPackageFiles, chProjectDir } from 'lionconfig';
chProjectDir(import.meta.url);
rmDist();
await tsc();
await copyPackageFiles();
