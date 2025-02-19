/**
 * @license
 * Copyright 2018 The Emscripten Authors
 * SPDX-License-Identifier: MIT
 */

mergeInto(LibraryManager.library, {
  $NODERAWFS__deps: ['$ERRNO_CODES', '$FS', '$NODEFS', '$mmapAlloc', '$FS_modeStringToFlags'],
  $NODERAWFS__postset: `
    if (ENVIRONMENT_IS_NODE) {
      var _wrapNodeError = function(func) {
        return function() {
          try {
            return func.apply(this, arguments)
          } catch (e) {
            if (e.code) {
              throw new FS.ErrnoError(ERRNO_CODES[e.code]);
            }
            throw e;
          }
        }
      };
      var VFS = Object.assign({}, FS);
      for (var _key in NODERAWFS) {
        FS[_key] = _wrapNodeError(NODERAWFS[_key]);
      }
    } else {
      throw new Error("NODERAWFS is currently only supported on Node.js environment.")
    }`,
  $NODERAWFS: {
    lookup: function(parent, name) {
#if ASSERTIONS
      assert(parent)
      assert(parent.path)
#endif
      return FS.lookupPath(`${parent.path}/${name}`).node;
    },
    lookupPath: function(path, opts = {}) {
      if (opts.parent) {
        path = nodePath.dirname(path);
      }
      var st = fs.lstatSync(path);
      var mode = NODEFS.getMode(path);
      return { path: path, node: { id: st.ino, mode: mode, node_ops: NODERAWFS, path: path }};
    },
    createStandardStreams: function() {
      FS.createStream({ nfd: 0, position: 0, path: '', flags: 0, tty: true, seekable: false }, 0);
      for (var i = 1; i < 3; i++) {
        FS.createStream({ nfd: i, position: 0, path: '', flags: 577, tty: true, seekable: false }, i);
      }
    },
    // generic function for all node creation
    cwd: function() { return process.cwd(); },
    chdir: function() { process.chdir.apply(void 0, arguments); },
    mknod: function(path, mode) {
      if (FS.isDir(path)) {
        fs.mkdirSync(path, mode);
      } else {
        fs.writeFileSync(path, '', { mode: mode });
      }
    },
    mkdir: function() { fs.mkdirSync.apply(void 0, arguments); },
    symlink: function() { fs.symlinkSync.apply(void 0, arguments); },
    rename: function() { fs.renameSync.apply(void 0, arguments); },
    rmdir: function() { fs.rmdirSync.apply(void 0, arguments); },
    readdir: function() { return ['.', '..'].concat(fs.readdirSync.apply(void 0, arguments)); },
    unlink: function() { fs.unlinkSync.apply(void 0, arguments); },
    readlink: function() { return fs.readlinkSync.apply(void 0, arguments); },
    stat: function() { return fs.statSync.apply(void 0, arguments); },
    lstat: function() { return fs.lstatSync.apply(void 0, arguments); },
    chmod: function() { fs.chmodSync.apply(void 0, arguments); },
    fchmod: function(fd, mode) {
      var stream = FS.getStreamChecked(fd);
      fs.fchmodSync(stream.nfd, mode);
    },
    chown: function() { fs.chownSync.apply(void 0, arguments); },
    fchown: function(fd, owner, group) {
      var stream = FS.getStreamChecked(fd);
      fs.fchownSync(stream.nfd, owner, group);
    },
    truncate: function() { fs.truncateSync.apply(void 0, arguments); },
    ftruncate: function(fd, len) {
      // See https://github.com/nodejs/node/issues/35632
      if (len < 0) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      var stream = FS.getStreamChecked(fd);
      fs.ftruncateSync(stream.nfd, len);
    },
    utime: function(path, atime, mtime) { fs.utimesSync(path, atime/1000, mtime/1000); },
    open: function(path, flags, mode) {
      if (typeof flags == "string") {
        flags = FS_modeStringToFlags(flags)
      }
      var pathTruncated = path.split('/').map(function(s) { return s.substr(0, 255); }).join('/');
      var nfd = fs.openSync(pathTruncated, NODEFS.flagsForNode(flags), mode);
      var st = fs.fstatSync(nfd);
      if (flags & {{{ cDefs.O_DIRECTORY }}} && !st.isDirectory()) {
        fs.closeSync(nfd);
        throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR);
      }
      var newMode = NODEFS.getMode(pathTruncated);
      var node = { id: st.ino, mode: newMode, node_ops: NODERAWFS, path: path }
      return FS.createStream({ nfd: nfd, position: 0, path: path, flags: flags, node: node, seekable: true });
    },
    createStream: function(stream, fd) {
      // Call the original FS.createStream
      var rtn = VFS.createStream(stream, fd);
      if (typeof rtn.shared.refcnt == 'undefined') {
        rtn.shared.refcnt = 1;
      } else {
        rtn.shared.refcnt++;
      }
      return rtn;
    },
    close: function(stream) {
      VFS.closeStream(stream.fd);
      if (!stream.stream_ops && --stream.shared.refcnt === 0) {
        // This stream is created by our Node.js filesystem, close the
        // native file descriptor when its reference count drops to 0.
        fs.closeSync(stream.nfd);
      }
    },
    llseek: function(stream, offset, whence) {
      if (stream.stream_ops) {
        // this stream is created by in-memory filesystem
        return VFS.llseek(stream, offset, whence);
      }
      var position = offset;
      if (whence === {{{ cDefs.SEEK_CUR }}}) {
        position += stream.position;
      } else if (whence === {{{ cDefs.SEEK_END }}}) {
        position += fs.fstatSync(stream.nfd).size;
      } else if (whence !== {{{ cDefs.SEEK_SET }}}) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }

      if (position < 0) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      stream.position = position;
      return position;
    },
    read: function(stream, buffer, offset, length, position) {
      if (stream.stream_ops) {
        // this stream is created by in-memory filesystem
        return VFS.read(stream, buffer, offset, length, position);
      }
      var seeking = typeof position != 'undefined';
      if (!seeking && stream.seekable) position = stream.position;
      var bytesRead = fs.readSync(stream.nfd, Buffer.from(buffer.buffer), offset, length, position);
      // update position marker when non-seeking
      if (!seeking) stream.position += bytesRead;
      return bytesRead;
    },
    write: function(stream, buffer, offset, length, position) {
      if (stream.stream_ops) {
        // this stream is created by in-memory filesystem
        return VFS.write(stream, buffer, offset, length, position);
      }
      if (stream.flags & +"{{{ cDefs.O_APPEND }}}") {
        // seek to the end before writing in append mode
        FS.llseek(stream, 0, +"{{{ cDefs.SEEK_END }}}");
      }
      var seeking = typeof position != 'undefined';
      if (!seeking && stream.seekable) position = stream.position;
      var bytesWritten = fs.writeSync(stream.nfd, Buffer.from(buffer.buffer), offset, length, position);
      // update position marker when non-seeking
      if (!seeking) stream.position += bytesWritten;
      return bytesWritten;
    },
    allocate: function() {
      throw new FS.ErrnoError({{{ cDefs.EOPNOTSUPP }}});
    },
    mmap: function(stream, length, position, prot, flags) {
      if (stream.stream_ops) {
        // this stream is created by in-memory filesystem
        return VFS.mmap(stream, length, position, prot, flags);
      }

      var ptr = mmapAlloc(length);
      FS.read(stream, HEAP8, ptr, length, position);
      return { ptr: ptr, allocated: true };
    },
    msync: function(stream, buffer, offset, length, mmapFlags) {
      if (stream.stream_ops) {
        // this stream is created by in-memory filesystem
        return VFS.msync(stream, buffer, offset, length, mmapFlags);
      }

      FS.write(stream, buffer, 0, length, offset);
      // should we check if bytesWritten and length are the same?
      return 0;
    },
    munmap: function() {
      return 0;
    },
    ioctl: function() {
      throw new FS.ErrnoError({{{ cDefs.ENOTTY }}});
    }
  }
});
