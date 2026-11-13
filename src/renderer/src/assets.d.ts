/** Vite turns an imported image into its URL. */
declare module '*.png' {
  const url: string
  export default url
}

/** Stylesheets are bundled by Vite. */
declare module '*.css'
