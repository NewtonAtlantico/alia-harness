/** The last part of a folder path, whatever separator it uses (`C:\Projetos\portal-cliente` is `portal-cliente`). */
export function projectName(projectPath: string): string {
  const parts = projectPath.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? projectPath;
}
