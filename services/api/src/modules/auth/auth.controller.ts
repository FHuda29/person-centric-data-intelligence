import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Param,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { config } from '../../config';
import { CurrentUser, Public, RequestId, Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { AuthUser, Role } from '../../common/types';
import { AuditService } from '../audit/audit.service';
import { newTotpSecret, otpauthUrl, verifyTotp } from './totp';

const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/;

@Injectable()
export class AuthService {
  private readonly log = new Logger('Auth');
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
  ) {}

  /** Seeds the bootstrap admin and analyst accounts on an empty user table. */
  async seedUsers(): Promise<void> {
    const n = await this.db.one<{ c: string }>('SELECT count(*)::text AS c FROM iam.users');
    if (Number(n?.c) > 0) return;
    const seed = async (u: string, p: string, name: string, role: Role, pii: boolean) =>
      this.db.query(
        `INSERT INTO iam.users(username, display_name, password_hash, role, can_reveal_pii) VALUES ($1,$2,$3,$4,$5)`,
        [u, name, await bcrypt.hash(p, 10), role, pii],
      );
    await seed(config.adminUsername, config.adminPassword, 'Platform Administrator', 'ADMIN', true);
    await seed(config.analystUsername, config.analystPassword, 'Intelligence Analyst', 'ANALYST', false);
    this.log.log(`Seeded users "${config.adminUsername}" and "${config.analystUsername}"`);
  }

  issue(u: any, mfaPending = false) {
    return this.jwt.sign(
      { sub: u.id, username: u.username, name: u.display_name, role: u.role, pii: u.can_reveal_pii, mfaPending },
      { expiresIn: mfaPending ? '5m' : (config.jwtTtl as any) },
    );
  }
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly db: DbService,
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Post('login')
  async login(@Body() body: { username?: string; password?: string; otp?: string }, @RequestId() rid: string) {
    const u = await this.db.one('SELECT * FROM iam.users WHERE username = $1 AND active', [body.username ?? '']);
    const ok = u && (await bcrypt.compare(body.password ?? '', u.password_hash));
    if (!ok) {
      await this.audit.record({ action: 'auth.login.failed', objectType: 'user', objectId: body.username ?? null, requestId: rid });
      throw new UnauthorizedException('Invalid credentials');
    }
    if (u.mfa_enabled) {
      if (!body.otp) return { mfaRequired: true };
      if (!verifyTotp(u.mfa_secret, body.otp)) {
        await this.audit.record({ action: 'auth.mfa.failed', objectType: 'user', objectId: u.id, requestId: rid });
        throw new UnauthorizedException('Invalid MFA code');
      }
    }
    const actor = { id: u.id, username: u.username } as AuthUser;
    await this.audit.record({ actor, action: 'auth.login', objectType: 'user', objectId: u.id, requestId: rid });
    return { token: this.auth.issue(u), user: this.profile(u) };
  }

  private profile(u: any) {
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      canRevealPii: u.can_reveal_pii,
      mfaEnabled: u.mfa_enabled,
    };
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    return this.profile(await this.db.one('SELECT * FROM iam.users WHERE id = $1', [user.id]));
  }

  @Post('mfa/setup')
  async mfaSetup(@CurrentUser() user: AuthUser) {
    const secret = newTotpSecret();
    await this.db.query('UPDATE iam.users SET mfa_secret = $2 WHERE id = $1 AND NOT mfa_enabled', [user.id, secret]);
    return { secret, otpauthUrl: otpauthUrl(secret, user.username) };
  }

  @Post('mfa/enable')
  async mfaEnable(@CurrentUser() user: AuthUser, @Body() body: { otp: string }, @RequestId() rid: string) {
    const u = await this.db.one('SELECT mfa_secret FROM iam.users WHERE id = $1', [user.id]);
    if (!u?.mfa_secret || !verifyTotp(u.mfa_secret, body.otp)) throw new BadRequestException('Invalid code');
    await this.db.query('UPDATE iam.users SET mfa_enabled = true WHERE id = $1', [user.id]);
    await this.audit.record({ actor: user, action: 'auth.mfa.enabled', objectType: 'user', objectId: user.id, requestId: rid });
    return { mfaEnabled: true };
  }

  @Post('password')
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() body: { current: string; next: string },
    @RequestId() rid: string,
  ) {
    const u = await this.db.one('SELECT password_hash FROM iam.users WHERE id = $1', [user.id]);
    if (!(await bcrypt.compare(body.current ?? '', u.password_hash))) throw new BadRequestException('Wrong password');
    if (!PASSWORD_RE.test(body.next ?? '')) {
      throw new BadRequestException('Password needs ≥10 chars with upper, lower case and a digit');
    }
    await this.db.query('UPDATE iam.users SET password_hash = $2 WHERE id = $1', [user.id, await bcrypt.hash(body.next, 10)]);
    await this.audit.record({ actor: user, action: 'auth.password.changed', objectType: 'user', objectId: user.id, requestId: rid });
    return { ok: true };
  }
}

@Controller('users')
@Roles('ADMIN')
export class UsersController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return this.db.query(
      `SELECT id, username, display_name, role, can_reveal_pii, mfa_enabled, active, created_at FROM iam.users ORDER BY username`,
    );
  }

  @Post()
  async create(
    @CurrentUser() actor: AuthUser,
    @Body() b: { username: string; displayName: string; password: string; role: Role; canRevealPii?: boolean },
    @RequestId() rid: string,
  ) {
    if (!/^[a-z0-9._-]{3,40}$/.test(b.username ?? '')) throw new BadRequestException('Invalid username');
    if (!['ADMIN', 'ANALYST', 'VIEWER'].includes(b.role)) throw new BadRequestException('Invalid role');
    if (!PASSWORD_RE.test(b.password ?? '')) {
      throw new BadRequestException('Password needs ≥10 chars with upper, lower case and a digit');
    }
    const u = await this.db.one(
      `INSERT INTO iam.users(username, display_name, password_hash, role, can_reveal_pii)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, username, display_name, role, can_reveal_pii`,
      [b.username, b.displayName || b.username, await bcrypt.hash(b.password, 10), b.role, !!b.canRevealPii],
    );
    await this.audit.record({ actor, action: 'user.created', objectType: 'user', objectId: u.id, requestId: rid, detail: { role: b.role } });
    return u;
  }

  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() b: { role?: Role; canRevealPii?: boolean; active?: boolean },
    @RequestId() rid: string,
  ) {
    const u = await this.db.one(
      `UPDATE iam.users SET role = COALESCE($2, role), can_reveal_pii = COALESCE($3, can_reveal_pii),
         active = COALESCE($4, active) WHERE id = $1
       RETURNING id, username, display_name, role, can_reveal_pii, active`,
      [id, b.role ?? null, b.canRevealPii ?? null, b.active ?? null],
    );
    await this.audit.record({ actor, action: 'user.updated', objectType: 'user', objectId: id, requestId: rid, detail: b as any });
    return u;
  }
}
