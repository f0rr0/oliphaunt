Pod::Spec.new do |s|
  s.name = 'OliphauntICU'
  s.version = '0.0.0' # x-release-please-version
  s.summary = 'Portable ICU data files for Oliphaunt runtimes.'
  s.homepage = 'https://oliphaunt.dev'
  s.license = { :type => 'MIT AND Unicode-3.0' }
  s.author = { 'Oliphaunt Maintainers' => 'https://github.com/f0rr0' }
  s.source = { :path => '.' }
  s.platforms = { :ios => '17.0', :osx => '14.0' }
  s.resource_bundles = {
    'OliphauntICU' => ['share/icu/**/*']
  }
end
