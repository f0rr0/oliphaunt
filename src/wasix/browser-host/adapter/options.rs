use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::Context;
use js_sys::Array;
use virtual_fs::{TmpFileSystem, random_file::RandomFile};
use wasm_bindgen::{JsCast, JsValue, convert::TryFromJsValue, prelude::wasm_bindgen};
use wasmer_wasix::{
    WasiEnvBuilder,
    capabilities::{WasiFdClosePolicy, WasiGuestExecutionMode, WasiHostPolicy},
};

use super::{Directory, DirectoryInit, StringOrBytes, utils::Error};

const OLIPHAUNT_PROTOCOL_DEVICE: &str = "/dev/oliphaunt-pgwire";
#[wasm_bindgen(typescript_custom_section)]
const TYPE_DEFINITIONS: &str = r#"
type CommonOptions = { args?: string[]; env?: Record<string, string>; stdin?: string | Uint8Array; mount?: Record<string, DirectoryInit | Directory>; cwd?: string; };
export type RunOptions = CommonOptions & { program?: string; moduleBytes?: Uint8Array; };
"#;
#[wasm_bindgen]
extern "C" {
    type OptionalDirectories;
    #[wasm_bindgen(typescript_type = "CommonOptions", extends = js_sys::Object)]
    pub type CommonOptions;

    #[wasm_bindgen(method, getter)]
    fn cwd(this: &CommonOptions) -> Option<String>;

    #[wasm_bindgen(method, getter)]
    fn args(this: &CommonOptions) -> Option<Array>;

    #[wasm_bindgen(method, getter)]
    fn env(this: &CommonOptions) -> JsValue;

    #[wasm_bindgen(method, getter)]
    fn stdin(this: &CommonOptions) -> Option<StringOrBytes>;

    #[wasm_bindgen(method, getter)]
    fn mount(this: &CommonOptions) -> OptionalDirectories;
}

impl CommonOptions {
    pub(crate) fn parse_args(&self) -> Result<Vec<String>, Error> {
        match self.args() {
            Some(args) => super::utils::js_string_array(args),
            None => Ok(Vec::new()),
        }
    }

    pub(crate) fn parse_cwd(&self) -> Result<Option<String>, Error> {
        match self.cwd() {
            Some(cwd) => Ok(Some(cwd)),
            None => Ok(None),
        }
    }

    pub(crate) fn parse_env(&self) -> Result<BTreeMap<String, String>, Error> {
        match self.env().dyn_ref() {
            Some(env) => {
                let vars = super::utils::js_record_of_strings(env)?;
                Ok(vars.into_iter().collect())
            }
            None => Ok(BTreeMap::new()),
        }
    }

    pub(crate) fn read_stdin(&self) -> Option<Vec<u8>> {
        self.stdin().map(|s| s.as_bytes())
    }

    pub(crate) fn mounted_directories(&self) -> Result<Vec<(String, Directory)>, Error> {
        let Ok(obj) = self.mount().dyn_into::<js_sys::Object>() else {
            return Ok(Vec::new());
        };

        let entries: BTreeMap<js_sys::JsString, JsValue> = super::utils::object_entries(&obj)?;
        let mut mounted_directories = Vec::new();

        for (key, value) in &entries {
            let key = String::from(key.clone());

            // Note: the value is a `Directory | DirectoryInit`

            let clone = js_sys::Reflect::get(value, &JsValue::from_str("__cloneForMount"))
                .ok()
                .and_then(|method| method.dyn_into::<js_sys::Function>().ok())
                .map(|method| method.call0(value))
                .transpose()
                .map_err(Error::js)?;
            let directory = clone.and_then(|clone| Directory::try_from_js_value(clone).ok());
            let value = if let Some(dir) = directory {
                dir
            } else if value.is_object() {
                // looks like we were given parameters for initializing a
                // Directory and need to call the constructor ourselves
                let init: &DirectoryInit = value.unchecked_ref();
                Directory::new(Some(init.clone()))?
            } else {
                unreachable!();
            };
            mounted_directories.push((key, value));
        }

        Ok(mounted_directories)
    }
}

impl Default for CommonOptions {
    fn default() -> Self {
        // Note: all fields are optional, so it's fine to use an empty object.
        CommonOptions {
            obj: js_sys::Object::new(),
        }
    }
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "RunOptions", extends = CommonOptions)]
    #[derive(Default)]
    pub type RunOptions;

    #[wasm_bindgen(method, getter)]
    pub(crate) fn program(this: &RunOptions) -> JsValue;

    #[wasm_bindgen(method, getter, js_name = moduleBytes)]
    pub(crate) fn module_bytes(this: &RunOptions) -> Option<js_sys::Uint8Array>;

}

impl RunOptions {
    pub(crate) fn configure_direct_builder(
        &self,
        builder: &mut WasiEnvBuilder,
        stdin: Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>,
        stdout: Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>,
        stderr: Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>,
    ) -> Result<(), Error> {
        self.configure_common_builder(builder, None)?;
        builder.set_host_policy(WasiHostPolicy::new(
            WasiGuestExecutionMode::SingleProgram,
            WasiFdClosePolicy::WritesCompleteSynchronously,
        ));

        builder.set_stdin(stdin);
        builder.set_stdout(stdout);
        builder.set_stderr(stderr);

        Ok(())
    }

    /// Propagate any provided options to the [`WasiEnvBuilder`], returning
    /// streams that can be used for stdin/stdout/stderr.
    pub(crate) fn configure_builder(
        &self,
        builder: &mut WasiEnvBuilder,
    ) -> Result<
        (
            Option<web_sys::WritableStream>,
            web_sys::ReadableStream,
            web_sys::ReadableStream,
        ),
        Error,
    > {
        self.configure_common_builder(builder, None)?;
        Ok(self.configure_stdio(builder))
    }

    pub(crate) fn configure_tool_direct_builder(
        &self,
        builder: &mut WasiEnvBuilder,
        protocol: Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>,
        stdout: Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>,
        stderr: Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>,
    ) -> Result<(), Error> {
        self.configure_common_builder(builder, Some(protocol))?;
        builder.set_host_policy(WasiHostPolicy::new(
            WasiGuestExecutionMode::SingleProgram,
            WasiFdClosePolicy::WritesCompleteSynchronously,
        ));
        builder.add_env("OLIPHAUNT_DIRECT_PGWIRE", OLIPHAUNT_PROTOCOL_DEVICE);
        match self.read_stdin() {
            Some(input) => builder.set_stdin(Box::new(virtual_fs::StaticFile::new(input))),
            None => builder.set_stdin(Box::<virtual_fs::null_file::NullFile>::default()),
        };
        builder.set_stdout(stdout);
        builder.set_stderr(stderr);

        Ok(())
    }

    fn configure_stdio(
        &self,
        builder: &mut WasiEnvBuilder,
    ) -> (
        Option<web_sys::WritableStream>,
        web_sys::ReadableStream,
        web_sys::ReadableStream,
    ) {
        let stdin = match self.read_stdin() {
            Some(stdin) => {
                builder.set_stdin(Box::new(virtual_fs::StaticFile::new(stdin)));
                None
            }
            None => {
                let (file, stream) = super::streams::input_pipe();
                builder.set_stdin(Box::new(file));
                Some(stream)
            }
        };
        let (stdout_file, stdout) = super::streams::output_pipe();
        builder.set_stdout(Box::new(stdout_file));
        let (stderr_file, stderr) = super::streams::output_pipe();
        builder.set_stderr(Box::new(stderr_file));
        (stdin, stdout, stderr)
    }

    fn configure_common_builder(
        &self,
        builder: &mut WasiEnvBuilder,
        protocol_file: Option<Box<dyn virtual_fs::VirtualFile + Send + Sync + 'static>>,
    ) -> Result<(), Error> {
        for arg in self.parse_args()? {
            builder.add_arg(arg);
        }

        for (key, value) in self.parse_env()? {
            builder.add_env(key, value);
        }

        if let Some(cwd) = self.parse_cwd()? {
            builder.set_current_dir(cwd);
        }
        let fs = self.filesystem()?;
        if let Some(protocol_file) = protocol_file {
            fs.new_open_options_ext()
                .insert_device_file(PathBuf::from(OLIPHAUNT_PROTOCOL_DEVICE), protocol_file)
                .with_context(|| format!("Unable to create {OLIPHAUNT_PROTOCOL_DEVICE}"))?;
        }
        builder.set_fs(Arc::new(fs) as Arc<dyn virtual_fs::FileSystem + Send + Sync>);
        builder.add_preopen_dir("/")?;

        Ok(())
    }

    pub(crate) fn filesystem(&self) -> Result<TmpFileSystem, Error> {
        let root = TmpFileSystem::new();
        for path in ["/dev", "/dev/shm"] {
            virtual_fs::FileSystem::create_dir(&root, Path::new(path))
                .with_context(|| format!("Unable to create \"{path}\""))?;
        }
        root.new_open_options_ext()
            .insert_device_file(PathBuf::from("/dev/urandom"), Box::<RandomFile>::default())
            .context("Unable to create /dev/urandom")?;

        for (dest, fs) in self.mounted_directories()? {
            tracing::trace!(%dest, ?fs, "Mounting directory");

            let fs = Arc::new(fs) as Arc<dyn virtual_fs::FileSystem + Send + Sync>;
            root.new_open_options_ext()
                .mount(dest.as_str().into(), &fs, "/".into())
                .with_context(|| format!("Unable to mount to \"{dest}\""))?;
        }

        tracing::trace!(?root, "Initialized the filesystem");

        Ok(root)
    }
}
