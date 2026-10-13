// esbuild inlines .html files as text (see the build script)
declare module '*.html' {
  const text: string
  export default text
}
