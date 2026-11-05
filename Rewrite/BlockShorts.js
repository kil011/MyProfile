/*
 * BlockShorts.js — 专门屏蔽 YouTube Shorts 导航入口（QuanX / Surge / Loon 通用）
 *
 * 作用（只做这一件事，不碰广告、播放、字幕）：
 *   1. 拦截 youtubei/v1/guide 的返回，删掉 browseId 为 FEshorts 的导航入口，
 *      也就是 App 底部 / 侧边栏的 Shorts 入口。
 *   2. 配合 BlockShorts.conf 里对 reel 接口的拦截，点进 Shorts  feed 也加载不出来。
 *
 * 原理：
 *   - guide 返回可能是 JSON，也可能是 protobuf 二进制（新版 iOS App 常用后者）。
 *   - JSON：递归删掉 browseId / pivotIdentifier 为 FEshorts 的对象。
 *   - protobuf：按 wire format 解析，递归重建，只删掉“2 层以内就包含
 *     FEshorts 字符串、且体积 < 1500 字节”的那个最小字段（也就是单个导航
 *     入口），不会把整个导航分区一起删掉。分区里 FEshorts 藏得更深（3 层
 *     以上），所以不会被误删。
 *   - 任何一步解析失败、或没找到 FEshorts，都原样返回，不破坏正常导航。
 *
 * 来源说明：这是为 kil011/MyProfile 写的独立小脚本，不是 Maasea
 * youtube.response.js 的复制。Maasea 的完整版还能去广告、开 PiP/后台播放，
 * 但它默认 blockShorts=false，且在 QuanX 下传参无效；本脚本只解决
 * Shorts 入口这一件事，可以和它叠加使用。
 *
 * 用法（QuanX）：见同目录 BlockShorts.conf
 *   ^https://youtubei.googleapis.com/youtubei/v1/guide url script-response-body <本文件 raw 链接>
 *   hostname = youtubei.googleapis.com
 */

(function () {
  var TARGET = "FEshorts";
  var MAX_ENTRY_BYTES = 1500;
  var MAX_DEPTH = 2;

  function failSafe(body) {
    try { $done({ body: body }); } catch (e) { try { $done(body); } catch (e2) {} }
  }

  var raw = $response.body;
  if (raw === undefined || raw === null) { failSafe(raw); return; }

  // ---------- JSON 分支 ----------
  var asText = null;
  if (typeof raw === "string") asText = raw;
  try {
    if (asText !== null && asText.trim().charAt(0) === "{") {
      var obj = JSON.parse(asText);
      var removed = 0;
      (function walk(node) {
        if (Array.isArray(node)) {
          for (var i = node.length - 1; i >= 0; i--) {
            var it = node[i];
            if (it && typeof it === "object" && isShortsEntry(it)) { node.splice(i, 1); removed++; }
            else walk(it);
          }
        } else if (node && typeof node === "object") {
          Object.keys(node).forEach(function (k) { walk(node[k]); });
        }
      })(obj);
      if (removed > 0) failSafe(JSON.stringify(obj));
      else failSafe(raw);
      return;
    }
  } catch (e) {
    // 不是合法 JSON，继续走 protobuf 分支
  }

  function isShortsEntry(o) {
    if (!o || typeof o !== "object") return false;
    if (o.browseId === TARGET || o.pivotIdentifier === TARGET) return true;
    var nav = o.navigationEndpoint;
    if (nav && nav.browseEndpoint && nav.browseEndpoint.browseId === TARGET) return true;
    var entry = o.guideEntryRenderer;
    if (entry && isShortsEntry(entry)) return true;
    return false;
  }

  // ---------- protobuf 分支 ----------
  var bytes;
  var inputWasString = false;
  try {
    if (typeof raw === "string") {
      inputWasString = true;
      bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
    } else if (raw instanceof Uint8Array) {
      bytes = raw;
    } else if (raw instanceof ArrayBuffer) {
      bytes = new Uint8Array(raw);
    } else {
      failSafe(raw); return;
    }
  } catch (e) { failSafe(raw); return; }

  // 读 varint，返回 {value, next}，失败返回 null
  function readVarint(buf, pos) {
    var value = 0, shift = 0;
    while (pos < buf.length) {
      var b = buf[pos++];
      value += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) return { value: value, next: pos };
      shift += 7;
      if (shift > 63) return null;
    }
    return null;
  }

  function encodeVarint(v) {
    var out = [];
    do { var b = v % 128; v = Math.floor(v / 128); if (v > 0) b += 0x80; out.push(b); } while (v > 0);
    return new Uint8Array(out);
  }

  function concat(parts) {
    var len = 0; parts.forEach(function (p) { len += p.length; });
    var out = new Uint8Array(len), off = 0;
    parts.forEach(function (p) { out.set(p, off); off += p.length; });
    return out;
  }

  // 解析一段 protobuf，返回字段数组，失败返回 null
  function parseMessage(buf) {
    var fields = [], pos = 0;
    while (pos < buf.length) {
      var tag = readVarint(buf, pos);
      if (!tag) return null;
      pos = tag.next;
      var fieldNo = Math.floor(tag.value / 8), wire = tag.value % 8;
      if (fieldNo <= 0) return null;
      var f = { field: fieldNo, wire: wire, tagBytes: encodeVarint(tag.value) };
      if (wire === 0) {
        var v = readVarint(buf, pos); if (!v) return null;
        f.raw = buf.slice(pos, v.next); pos = v.next;
      } else if (wire === 1) {
        if (pos + 8 > buf.length) return null;
        f.raw = buf.slice(pos, pos + 8); pos += 8;
      } else if (wire === 5) {
        if (pos + 4 > buf.length) return null;
        f.raw = buf.slice(pos, pos + 4); pos += 4;
      } else if (wire === 2) {
        var l = readVarint(buf, pos); if (!l) return null;
        pos = l.next;
        if (pos + l.value > buf.length) return null;
        f.lenBytes = encodeVarint(l.value);
        f.raw = buf.slice(pos, pos + l.value); pos += l.value;
        f.sub = parseMessage(f.raw);
        // 判断是不是纯字符串
        try { f.text = new TextDecoder().decode(f.raw); } catch (e) { f.text = null; }
      } else {
        return null;
      }
      fields.push(f);
    }
    return fields;
  }

  function containsShorts(fields, depth) {
    if (!fields || depth > MAX_DEPTH) return false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.wire === 2 && f.text === TARGET) return true;
      if (f.wire === 2 && f.sub && containsShorts(f.sub, depth + 1)) return true;
    }
    return false;
  }

  var dropped = 0;
  function rebuild(fields) {
    var parts = [];
    fields.forEach(function (f) {
      // 只删最小入口：wire2、体积小、3 层内含 FEshorts
      if (f.wire === 2 && f.raw.length <= MAX_ENTRY_BYTES && f.sub && containsShorts(f.sub, 0)) {
        dropped++;
        return;
      }
      if (f.wire === 2 && f.sub) {
        var rebuilt = rebuild(f.sub);
        parts.push(f.tagBytes, encodeVarint(rebuilt.length), rebuilt);
      } else if (f.wire === 2) {
        parts.push(f.tagBytes, f.lenBytes, f.raw);
      } else {
        parts.push(f.tagBytes, f.raw);
      }
    });
    return concat(parts);
  }

  var top;
  try { top = parseMessage(bytes); } catch (e) { top = null; }
  if (!top) { failSafe(raw); return; }

  var outBytes;
  try { outBytes = rebuild(top); } catch (e) { failSafe(raw); return; }
  if (dropped === 0) { failSafe(raw); return; }

  if (inputWasString) {
    var s = "";
    for (var j = 0; j < outBytes.length; j++) s += String.fromCharCode(outBytes[j]);
    failSafe(s);
  } else {
    failSafe(outBytes);
  }
})();
