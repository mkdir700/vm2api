import test from 'node:test'
import assert from 'node:assert/strict'
import { selectKernelAsset, selectCliNodeAsset } from '../../src/lib/admin/release-kernel.mjs'

test('selectKernelAsset accepts only the kin-kernel GitHub asset', () => {
  const picked = selectKernelAsset({
    tag_name: 'v1.3.2',
    assets: [
      { name: 'kin-worker', url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/1' },
      {
        name: 'kin-kernel',
        size: 64,
        url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/9',
        browser_download_url: 'https://evil.example/kin-kernel',
      },
    ],
  })
  assert.equal(picked.ok, true)
  assert.equal(picked.tag, 'v1.3.2')
  assert.equal(picked.url, 'https://api.github.com/repos/dofastted/vm2api/releases/assets/9')
  assert.equal(selectKernelAsset({ tag_name: 'v1.3.2', assets: [] }).code, 'kernel_asset_missing')
  assert.equal(
    selectCliNodeAsset({
      tag_name: 'v1.3.2',
      assets: [
        {
          name: 'cli-node',
          size: 64,
          url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/8',
        },
      ],
    }).asset,
    'cli-node',
  )
  assert.equal(selectCliNodeAsset({ tag_name: 'v1.3.2', assets: [] }).code, 'cli_node_asset_missing')
  assert.equal(
    selectKernelAsset({
      tag_name: 'v1.3.2',
      assets: [{ name: 'kin-kernel', size: 64, url: 'https://evil.example/kin-kernel' }],
    }).code,
    'kernel_asset_url',
  )
  assert.equal(
    selectKernelAsset({
      tag_name: 'v1.3.2',
      assets: [
        {
          name: 'kin-kernel',
          size: 33 * 1024 * 1024,
          url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/9',
        },
      ],
    }).code,
    'kernel_too_large',
  )
})
