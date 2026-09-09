package dev.oliphaunt

/** A resource selected from an extension package or the SDK's contrib values. */
public data class ExtensionDescriptor(
    val sqlName: String,
    val product: String,
    val version: String? = null,
) {
    init {
        require(Regex("[a-z0-9][a-z0-9_-]*").matches(sqlName)) { "invalid extension SQL name" }
        require(Regex("oliphaunt-extension-[a-z0-9-]+").matches(product)) { "invalid extension product" }
        require(version != null || product == "oliphaunt-extension-contrib-pg18") {
            "external extension descriptors must declare their package version"
        }
        version?.let(::validateResourceVersion)
    }
}

/** Optional ICU data supplied by its separately installed package. */
public data class IcuData(val version: String) {
    init {
        validateResourceVersion(version)
    }
}

private fun validateResourceVersion(version: String) {
    require(Regex("[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?").matches(version)) {
        "resource descriptor must declare a package version"
    }
}

internal fun selectedExtensionDescriptors(values: List<ExtensionDescriptor>): List<ExtensionDescriptor> {
    val selected = linkedMapOf<String, ExtensionDescriptor>()
    for (value in values) {
        val previous = selected.put(value.sqlName, value)
        require(previous == null || previous == value) { "conflicting extension descriptors for '${value.sqlName}'" }
    }
    return selected.values.toList()
}

internal fun selectedExtensionClosure(names: Collection<String>): Set<String> {
    val selected = linkedSetOf<String>()
    fun visit(name: String) {
        if (!selected.add(name)) return
        val contract = generatedExtensionRuntimeContract(name)
            ?: throw OliphauntException("unknown extension '$name'")
        contract.dependencies.forEach(::visit)
    }
    names.forEach(::visit)
    return selected
}

internal fun includeSelectedRuntimeFile(path: String, extensions: Set<String>, icu: Boolean): Boolean {
    if (!icu && (path == "share/icu" || path.startsWith("share/icu/"))) return false
    val file = path.substringAfterLast('/')
    if (path.startsWith("share/postgresql/extension/")) {
        val owner = generatedExtensionSqlNames.firstOrNull { name ->
            file == "$name.control" || file == "$name.sql" || file.startsWith("$name--")
        }
        if (owner != null && owner !in extensions) return false
    }
    if (path.startsWith("lib/postgresql/")) {
        val owners = generatedExtensionRuntimeContracts.filterValues { contract ->
            contract.nativeModuleStem?.let { file == "$it.so" || file == "$it.dylib" } == true
        }.keys
        if (owners.isNotEmpty() && owners.none { it in extensions }) return false
    }
    return true
}
