#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { nanoid } from 'nanoid'
import sharp from 'sharp'
import * as vega from 'vega'
import * as vegaLite from 'vega-lite'
import { z } from 'zod'

const VERSION = '0.1.0'
const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 720
const MAX_DIMENSION = 2400
const MAX_RASTER_PIXELS = 12_000_000

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)

const RenderFormatSchema = z.enum(['svg', 'png']).default('svg')
const QuickFormatSchema = z.enum(['svg', 'png']).default('png')

const RenderChartInputSchema = {
  spec: z.record(z.string(), JsonValueSchema).describe('A complete Vega-Lite chart specification.'),
  format: RenderFormatSchema.describe('Output format. SVG is recommended for crisp in-app display.'),
  width: z.number().int().min(160).max(MAX_DIMENSION).default(DEFAULT_WIDTH).describe('Chart width in CSS pixels.'),
  height: z.number().int().min(120).max(MAX_DIMENSION).default(DEFAULT_HEIGHT).describe('Chart height in CSS pixels.'),
  scale: z.number().min(1).max(4).default(2).describe('PNG raster scale. Ignored for SVG output.'),
  background: z.string().default('#ffffff').describe('Chart background color. Use transparent for no background.'),
  title: z.string().optional().describe('Optional title override.'),
  filename: z.string().optional().describe('Optional base filename without extension.'),
}

const QuickChartInputSchema = {
  chartType: z.enum(['bar', 'line', 'area', 'scatter', 'pie']).describe('Common chart type to generate.'),
  data: z.array(z.record(z.string(), JsonValueSchema)).min(1).max(5000).describe('Array of tabular data objects.'),
  x: z.string().describe('Field name for the x/category/label axis.'),
  y: z.string().describe('Field name for the y/value axis.'),
  series: z.string().optional().describe('Optional field name used for color grouping.'),
  title: z.string().optional().describe('Optional chart title.'),
  xType: z.enum(['nominal', 'ordinal', 'quantitative', 'temporal']).optional().describe('Override Vega-Lite x field type.'),
  yType: z.enum(['nominal', 'ordinal', 'quantitative', 'temporal']).optional().describe('Override Vega-Lite y field type.'),
  format: QuickFormatSchema.describe('Output format. PNG is the default for broad model-vision compatibility.'),
  width: z.number().int().min(160).max(MAX_DIMENSION).default(DEFAULT_WIDTH),
  height: z.number().int().min(120).max(MAX_DIMENSION).default(DEFAULT_HEIGHT),
  scale: z.number().min(1).max(4).default(2),
  background: z.string().default('#ffffff'),
  filename: z.string().optional(),
}

type RenderChartArgs = z.infer<z.ZodObject<typeof RenderChartInputSchema>>
type QuickChartArgs = z.infer<z.ZodObject<typeof QuickChartInputSchema>>

function outputDir(): string {
  return resolve(process.env.CHART_ARTIFACTS_OUTPUT_DIR || join(tmpdir(), 'cynosure-chart-artifacts'))
}

function safeBaseName(name?: string): string {
  const cleaned = name?.trim().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || `chart-${Date.now()}-${nanoid(8)}`
}

function withDimensions(spec: Record<string, unknown>, width: number, height: number, background: string, title?: string): Record<string, unknown> {
  return {
    ...spec,
    width: spec.width ?? width,
    height: spec.height ?? height,
    background: background === 'transparent' ? null : background,
    ...(title ? { title } : {}),
    config: {
      ...(themeConfig()),
      ...((spec.config as Record<string, unknown> | undefined) || {}),
    },
  }
}

function themeConfig(): Record<string, unknown> {
  return {
    font: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    title: { fontSize: 22, fontWeight: 650, anchor: 'start', color: '#111827' },
    axis: {
      labelFontSize: 13,
      titleFontSize: 14,
      labelColor: '#374151',
      titleColor: '#111827',
      gridColor: '#e5e7eb',
      domainColor: '#9ca3af',
      tickColor: '#9ca3af',
    },
    legend: { labelFontSize: 13, titleFontSize: 14, labelColor: '#374151', titleColor: '#111827' },
    range: {
      category: ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#4f46e5', '#65a30d'],
    },
    view: { stroke: null },
  }
}

async function renderVegaLite(spec: Record<string, unknown>, options: {
  format: 'svg' | 'png'
  width: number
  height: number
  scale: number
  background: string
  title?: string
  filename?: string
}): Promise<{ path: string; data: Buffer; mimeType: string; format: 'svg' | 'png' }> {
  const finalSpec = withDimensions(spec, options.width, options.height, options.background, options.title)
  const compiled = vegaLite.compile(finalSpec as unknown as vegaLite.TopLevelSpec).spec
  const view = new vega.View(vega.parse(compiled), { renderer: 'none' })
  const svg = await view.toSVG()

  let data: Buffer
  let ext: 'svg' | 'png'
  let mimeType: string

  if (options.format === 'png') {
    const estimatedPixels = Math.ceil(options.width * options.scale) * Math.ceil(options.height * options.scale)
    if (estimatedPixels > MAX_RASTER_PIXELS) {
      throw new Error(`PNG output is too large (${estimatedPixels.toLocaleString()} pixels). Lower width, height, or scale.`)
    }
    data = await sharp(Buffer.from(svg), { density: 96 * options.scale }).png().toBuffer()
    ext = 'png'
    mimeType = 'image/png'
  } else {
    data = Buffer.from(svg, 'utf8')
    ext = 'svg'
    mimeType = 'image/svg+xml'
  }

  const dir = outputDir()
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${safeBaseName(options.filename)}.${ext}`)
  await writeFile(path, data)
  return { path, data, mimeType, format: ext }
}

function inferFieldType(rows: Array<Record<string, unknown>>, field: string, fallback: 'nominal' | 'quantitative'): 'nominal' | 'ordinal' | 'quantitative' | 'temporal' {
  const values = rows.map(row => row[field]).filter(value => value !== null && value !== undefined)
  if (!values.length) return fallback
  if (values.every(value => typeof value === 'number')) return 'quantitative'
  if (values.every(value => typeof value === 'string' && !Number.isNaN(Date.parse(value)))) return 'temporal'
  return fallback
}

function buildQuickSpec(args: QuickChartArgs): Record<string, unknown> {
  const xType = args.xType || inferFieldType(args.data, args.x, args.chartType === 'scatter' ? 'quantitative' : 'nominal')
  const yType = args.yType || inferFieldType(args.data, args.y, 'quantitative')
  const mark = args.chartType === 'pie'
    ? { type: 'arc', tooltip: true, innerRadius: 0 }
    : { type: args.chartType === 'scatter' ? 'point' : args.chartType, tooltip: true }

  if (args.chartType === 'pie') {
    return {
      $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
      data: { values: args.data },
      mark,
      encoding: {
        theta: { field: args.y, type: 'quantitative', stack: true },
        color: { field: args.x, type: xType },
        tooltip: [
          { field: args.x, type: xType },
          { field: args.y, type: 'quantitative' },
        ],
      },
    }
  }

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: { values: args.data },
    mark,
    encoding: {
      x: { field: args.x, type: xType },
      y: { field: args.y, type: yType },
      ...(args.series ? { color: { field: args.series, type: 'nominal' } } : {}),
      tooltip: [
        { field: args.x, type: xType },
        { field: args.y, type: yType },
        ...(args.series ? [{ field: args.series, type: 'nominal' }] : []),
      ],
    },
  }
}

function resultContent(rendered: { path: string; data: Buffer; mimeType: string; format: 'svg' | 'png' }, label: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `${label} rendered as ${rendered.format.toUpperCase()}.\nArtifact: ${rendered.path}`,
      },
      {
        type: 'image' as const,
        data: rendered.data.toString('base64'),
        mimeType: rendered.mimeType,
      },
    ],
  }
}

const server = new McpServer({
  name: '@cynosure-mcp/chart-artifacts',
  title: 'Chart Artifacts',
  version: VERSION,
  description: 'Render Vega-Lite charts as SVG or high-resolution PNG artifacts for Cynosure conversations.',
})

server.registerTool('render_chart', {
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  title: 'Render Chart',
  description: 'Render a complete Vega-Lite JSON spec as an SVG or high-resolution PNG chart artifact.',
  inputSchema: RenderChartInputSchema,
}, async (args) => {
  const parsed = z.object(RenderChartInputSchema).parse(args)
  const rendered = await renderVegaLite(parsed.spec, {
    format: parsed.format,
    width: parsed.width,
    height: parsed.height,
    scale: parsed.scale,
    background: parsed.background,
    title: parsed.title,
    filename: parsed.filename,
  })
  return resultContent(rendered, parsed.title || 'Chart')
})

server.registerTool('quick_chart', {
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  title: 'Quick Chart',
  description: 'Create a common chart from tabular data without writing a full Vega-Lite spec.',
  inputSchema: QuickChartInputSchema,
}, async (args) => {
  const parsed = z.object(QuickChartInputSchema).parse(args)
  const spec = buildQuickSpec(parsed)
  const rendered = await renderVegaLite(spec, {
    format: parsed.format,
    width: parsed.width,
    height: parsed.height,
    scale: parsed.scale,
    background: parsed.background,
    title: parsed.title,
    filename: parsed.filename,
  })
  return resultContent(rendered, parsed.title || `${parsed.chartType} chart`)
})

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  const entry = fileURLToPath(import.meta.url)
  console.error(`Chart Artifacts MCP ${VERSION} running from ${dirname(entry)}`)
}

main().catch((error) => {
  console.error('Chart Artifacts MCP failed:', error)
  process.exit(1)
})
