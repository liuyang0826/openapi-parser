import { Definition, Field, Interface, ParseResult, Schema } from '../types'
import { duplicate, matchRefTypeName, toFirstUpperCase } from '../utils'
import { ParameterV3, RequestDefinitionV3, SwaggerV3 } from './types'

const definitionPrefix = '#/components/schemas/'

function javaTypeToTsKeyword(schema: Schema): string | undefined {
  const { type = '', items, format } = schema
  if (type === 'file' || format === 'binary') return 'File'

  if (['number', 'integer'].includes(type)) return 'number'

  if (['string', 'boolean', 'object'].includes(type)) return type

  if (type === 'array') {
    const tsKeyword = items?.$ref ? items.$ref : items?.type ? javaTypeToTsKeyword(items) : null

    if (tsKeyword) return `${tsKeyword}[]`
  }
}

function transformInterfaceBody(
  interfaceBody: Field[],
  definitions: Record<string, Definition | undefined>,
  collector: Interface[],
  markRequired: boolean
) {
  interfaceBody.forEach((item) => {
    if (item.type.startsWith(definitionPrefix)) {
      const ref = item.type.split(/(\[.*\])?$/)[0]
      resolveInterface(ref, definitions, collector, markRequired)
      item.type = item.type.replace(/.*?(\[.*\])?$/, `${matchRefTypeName(definitionPrefix, item.type)}$1`)
    }
  })
}

function resolveProperties(
  name: string,
  definition: Definition | undefined,
  definitions: Record<string, Definition | undefined>,
  collector: Interface[],
  markRequired: boolean
) {
  const { properties, required = [], description } = definition || {}
  if (!properties) return
  const interfaceBody: Field[] = []

  Object.keys(properties).forEach((propName) => {
    const { type, $ref, description, format } = properties[propName] || {}
    const tsKeyword = $ref ? $ref : type ? javaTypeToTsKeyword(properties[propName] || {}) : null

    if (!tsKeyword) {
      console.log(`the ${propName} attribute of the ${$ref} is ignored`)

      return
    }

    interfaceBody.push({
      name: propName,
      optional: !markRequired || !required.includes(propName),
      type: tsKeyword || '',
      description,
      format,
    })
  })

  collector.unshift({
    name,
    description,
    fields: interfaceBody,
  })

  transformInterfaceBody(interfaceBody, definitions, collector, markRequired)
}

function resolveInterface(
  ref: string,
  definitions: Record<string, Definition | undefined>,
  collector: Interface[],
  markRequired: boolean
) {
  if (!ref) return
  const name = matchRefTypeName(definitionPrefix, ref)
  if (collector.some((d) => d.name === name)) return

  resolveProperties(name, definitions[ref.substring(definitionPrefix.length)], definitions, collector, markRequired)
}

function resolveParameters(
  interfaceName: string,
  parameters: ParameterV3[],
  definitions: Record<string, Definition | undefined>
) {
  const collector: Interface[] = []
  const interfaceBody: Field[] = []

  parameters.forEach((parameter) => {
    const { name, description, required, schema } = parameter

    if (schema?.$ref) {
      resolveInterface(schema.$ref, definitions, collector, true)
    }

    const tsKeyword = schema?.$ref ? schema.$ref : schema?.type ? javaTypeToTsKeyword(schema) : null

    if (!tsKeyword) {
      console.log(`the ${name} attribute of the ${interfaceName} is ignored`)

      return
    }

    interfaceBody.push({
      name,
      optional: !required,
      type: tsKeyword || '',
      description,
      format: schema?.format,
    })
  })

  if (interfaceBody.length) {
    collector.unshift({
      name: interfaceName,
      fields: interfaceBody,
    })
  }

  transformInterfaceBody(interfaceBody, definitions, collector, true)

  return collector
}

function resolveSchema(schema: Schema, definitions: Record<string, Definition | undefined>, defaultName: string) {
  const collector: Interface[] = []

  let name: string | undefined

  if (schema.type === 'array') {
    if (schema.items?.$ref) {
      resolveInterface(schema.items.$ref, definitions, collector, true)
      name = collector.at(-1)?.name
    } else {
      name = javaTypeToTsKeyword(schema)
    }
  } else {
    if (schema.$ref) {
      resolveInterface(schema.$ref, definitions, collector, true)
    } else {
      resolveProperties(defaultName, schema as Definition, definitions, collector, true)
    }

    name = collector.at(-1)?.name
  }

  return { collector, name }
}

function parseOperationId(operationId: string) {
  const index = operationId.indexOf('Using')

  return index === -1 ? operationId : operationId.slice(0, index)
}

function resolveQuery(
  pathVars: string[],
  definition: RequestDefinitionV3,
  definitions: Record<string, Definition | undefined>
) {
  const name = parseOperationId(definition.operationId)

  return resolveParameters(
    `${toFirstUpperCase(name)}Query`,
    definition.parameters?.filter((parameter) => {
      const { name } = parameter

      return parameter.in === 'query' && !pathVars.includes(name)
    }) || [],
    definitions
  )
}

function resolvePath(
  pathVars: string[],
  definition: RequestDefinitionV3,
  definitions: Record<string, Definition | undefined>
) {
  const name = parseOperationId(definition.operationId)

  return resolveParameters(
    `${toFirstUpperCase(name)}PathVar`,
    definition.parameters?.filter((parameter) => parameter.in === 'path' || pathVars.includes(parameter.name)) || [],
    definitions
  )
}

export default function parser(swaggerJSON: SwaggerV3, path: string, method: string): ParseResult | void {
  const {
    paths,
    components: { schemas: definitions },
  } = swaggerJSON

  const definition = paths[path]?.[method]
  if (!definition) return
  const name = parseOperationId(definition.operationId)
  const pathVars = path.match(/\{(.+?)\}/g)?.map((d) => d.slice(1, -1)) || []

  const pathVarTypes = resolvePath(pathVars, definition, definitions)
  const pathVar = pathVarTypes.at(-1)?.name

  const queryTypes = resolveQuery(pathVars, definition, definitions)
  const query = queryTypes.at(-1)?.name

  const { collector: bodyTypes, name: body } = resolveSchema(
    Object.values(definition.requestBody?.content || {})[0]?.schema || {},
    definitions,
    'RequestBody'
  )

  const { collector: resTypes, name: res } = resolveSchema(
    Object.values(definition.responses[200]?.content || {})[0]?.schema || {},
    definitions,
    'ResponseBody'
  )

  const { summary, description } = definition
  const comment = [summary, description].filter(Boolean).join(', ')

  return {
    name,
    comment,
    body,
    isFormData: Object.keys(definition.requestBody?.content || {})[0] === 'multipart/form-data',
    pathVar,
    query,
    res,
    interfaces: duplicate([...pathVarTypes, ...queryTypes, ...bodyTypes, ...resTypes]),
  }
}