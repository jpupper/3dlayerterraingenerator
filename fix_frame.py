with open('D:\\Programacion\\3dlayerterraingenerator\\public\\vectorviewer.html', 'r', encoding='utf-8') as f:
    content = f.read()

idx = content.find('function referenceMarkSvg')
end_marker = '\n\n// ═══════════════════════════════════════════════════════\nfunction buildLayerSvg('
end_idx = content.find(end_marker, idx)

new_func_lines = []
new_func_lines.append('function referenceMarkSvg(terrainWidth, terrainDepth, mgn) {')
new_func_lines.append('  const x = -mgn;')
new_func_lines.append('  const y = -mgn;')
new_func_lines.append('  const w = terrainWidth + 2*mgn;')
new_func_lines.append('  const h = terrainDepth + 2*mgn;')
new_func_lines.append('  // Corner L-marks wrapped in a path element with visible stroke')
new_func_lines.append('  const l = 1.5;')
new_func_lines.append('  const g = 0.3;')
new_func_lines.append("  const corners = '<path d=\"' +")
new_func_lines.append("    'M' + (x+g) + ',' + (y+g+l) + ' L' + (x+g) + ',' + (y+g) + ' L' + (x+g+l) + ',' + (y+g) +")
new_func_lines.append("    ' M' + (x+w-g-l) + ',' + (y+g) + ' L' + (x+w-g) + ',' + (y+g) + ' L' + (x+w-g) + ',' + (y+g+l) +")
new_func_lines.append("    ' M' + (x+w-g) + ',' + (y+h-g-l) + ' L' + (x+w-g) + ',' + (y+h-g) + ' L' + (x+w-g-l) + ',' + (y+h-g) +")
new_func_lines.append("    ' M' + (x+g+l) + ',' + (y+h-g) + ' L' + (x+g) + ',' + (y+h-g) + ' L' + (x+g) + ',' + (y+h-g-l) +")
new_func_lines.append("    '\" fill=\"none\" stroke=\"rgba(255,255,255,0.5)\" stroke-width=\"0.4\" stroke-linecap=\"round\"/>';")
new_func_lines.append('  // Dimension labels at center of each side')
new_func_lines.append('  const fontSize = Math.max(1.2, Math.min(w, h) * 0.018);')
new_func_lines.append('  const labels =')
new_func_lines.append("    '<text x=\"' + (x + w/2) + '\" y=\"' + (y - 1.0) + '\" text-anchor=\"middle\" fill=\"rgba(255,255,255,0.5)\" font-size=\"' + fontSize + '\" font-family=\"monospace\">' + terrainWidth + ' cm</text>' +")
new_func_lines.append("    '<text x=\"' + (x + w/2) + '\" y=\"' + (y + h + fontSize + 0.5) + '\" text-anchor=\"middle\" fill=\"rgba(255,255,255,0.5)\" font-size=\"' + fontSize + '\" font-family=\"monospace\">' + terrainWidth + ' cm</text>' +")
new_func_lines.append("    '<text x=\"' + (x - 0.8) + '\" y=\"' + (y + h/2) + '\" text-anchor=\"end\" fill=\"rgba(255,255,255,0.5)\" font-size=\"' + fontSize + '\" font-family=\"monospace\" transform=\"rotate(-90,' + (x - 0.8) + ',' + (y + h/2) + ')\">' + terrainDepth + ' cm</text>' +")
new_func_lines.append("    '<text x=\"' + (x + w + 0.8) + '\" y=\"' + (y + h/2) + '\" text-anchor=\"start\" fill=\"rgba(255,255,255,0.5)\" font-size=\"' + fontSize + '\" font-family=\"monospace\" transform=\"rotate(90,' + (x + w + 0.8) + ',' + (y + h/2) + ')\">' + terrainDepth + ' cm</text>';")
new_func_lines.append('  return corners + labels;')
new_func_lines.append('}')

new_func = '\n'.join(new_func_lines)

old_func = content[idx:end_idx]
print("Old function first 100 chars:", repr(old_func[:100]))
print("New function first 100 chars:", repr(new_func[:100]))

content = content[:idx] + new_func + content[end_idx:]

with open('D:\\Programacion\\3dlayerterraingenerator\\public\\vectorviewer.html', 'w', encoding='utf-8') as f:
    f.write(content)

# Verify no backslash escaping issues
new_idx = content.find('function referenceMarkSvg')
new_end = content.find(end_marker, new_idx)
fixed = content[new_idx:new_end]

backslash_dq = '\\\\"'
if backslash_dq in fixed:
    print("ERROR: still has backslash-escaped quotes!")
    for i, line in enumerate(fixed.split('\n')):
        if '\\\\' in line:
            print(f"  Line {i+1}: {repr(line)}")
else:
    print("OK - no broken backslash escaping")

# Verify the path element is valid
path_str = '<path d="'
if path_str in fixed:
    print("OK - path element has correct quoting")
else:
    print("ERROR: path element quoting is broken")

print("\nFixed function:")
print(fixed)
