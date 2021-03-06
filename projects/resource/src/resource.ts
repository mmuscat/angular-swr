import {
   ChangeDetectorRef,
   ErrorHandler,
   inject,
   Injectable,
   InjectFlags,
   OnDestroy,
   Type,
} from "@angular/core"
import { EMPTY, Observable, PartialObserver, Subject, Subscription } from "rxjs"
import { shareReplay } from "rxjs/operators"
import { DOCUMENT } from "@angular/common"

export interface Fetchable<T = unknown> {
   fetch(...args: any[]): Observable<T>
}

export interface ResourceOptions {
   providedIn?: Type<any> | "root" | "platform" | "any" | null
   revalidateIfStale?: boolean
   immutable?: boolean
   timeoutMs?: number
   dedupeMs?: number
   cache?: boolean
   serialize?: (...params: any[]) => string
   features?: ResourceFeatureWithOptions<any>[]
}

export type FetchParameters<T extends Fetchable> = Parameters<T["fetch"]>
export type FetchObservable<T extends Fetchable> = ReturnType<T["fetch"]>
export type FetchValue<T extends Fetchable> = FetchObservable<T> extends Observable<
   infer R
>
   ? R
   : never

export enum ResourceState {
   INITIAL,
   FETCH,
   SLOW,
   NEXT,
   ERROR,
   COMPLETE,
}

export class ResourceSubject<T extends Fetchable<any> = Fetchable> {
   next(value: FetchValue<T>): void {
      this.emit(ResourceState.NEXT, value, false, null)
   }

   error(error: unknown) {
      this.emit(ResourceState.ERROR, null, false, error)
   }

   complete() {
      this.emit(ResourceState.COMPLETE, null, false, null)
   }

   emit(
      state: ResourceState,
      value: any,
      pending: boolean,
      thrownError: unknown,
   ) {
      const { resource, subject, changeDetectorRef } = this
      clearTimeout(resource.timeout)
      resource.state = state
      resource.pending = pending
      resource.slow = state === ResourceState.SLOW
      resource.timeout = undefined
      switch (state) {
         case ResourceState.NEXT: {
            resource.value = value
            break
         }
         case ResourceState.ERROR: {
            resource.thrownError = thrownError
            break
         }
      }
      changeDetectorRef?.markForCheck()
      subject.next(resource)
   }

   asObservable() {
      return this.subject.asObservable()
   }

   constructor(
      private resource: Resource<T>,
      private subject: Subject<any>,
      private changeDetectorRef?: ChangeDetectorRef | null,
   ) {}
}

export const defaultOptions: ResourceOptions = Object.seal({
   dedupeMs: 2000,
   timeoutMs: 3000,
   revalidateIfStale: true,
   cache: true
})

function createFetchObservable(source: Observable<any>) {
   return source.pipe(shareReplay(1))
}

@Injectable({ providedIn: "root" })
export class CacheRegistry {
   private readonly registry = new Map()
   get(target: any, cacheStrategy = new Map()) {
      const cache = this.registry.get(target)
      if (cache) {
         return cache
      } else {
         this.registry.set(target, cacheStrategy)
         return cacheStrategy
      }
   }
}

function isWithinDedupeInterval(dedupeIntervalMs = 0, then = 0) {
   return (Date.now() - then) < dedupeIntervalMs
}

@Injectable()
export abstract class Resource<T extends Fetchable<any> = Fetchable>
   implements OnDestroy
{
   private readonly errorHandler: ErrorHandler
   private readonly observer: ResourceSubject<T>
   private readonly features: readonly [ResourceFeature, {}][]
   private readonly cache: Map<string, { source: Observable<FetchValue<T>>, lastModified?: number }> | null
   private readonly subject: Subject<any>
   private connected: boolean
   private subscription: Subscription
   private cacheKey?: string

   readonly options: ResourceOptions
   #value?: FetchValue<T>
   params?: FetchParameters<T>
   state: ResourceState
   thrownError: unknown
   source: Observable<FetchValue<T>>
   pending: boolean
   timeout?: number
   slow: boolean

   get value() {
      return this.read()
   }

   set value(value) {
      this.#value = value
   }

   get error() {
      return this.state === ResourceState.ERROR
   }

   get complete() {
      return this.state === ResourceState.COMPLETE
   }

   next(value?: FetchValue<T>) {
      this.observer.emit(this.state, value, this.pending, this.thrownError)
   }

   fetch(...params: FetchParameters<T>) {
      try {
         const cacheKey = this.getCacheKey(params)
         const cache = this.cache?.get(cacheKey)
         const shouldDedupe = isWithinDedupeInterval(
            this.options.dedupeMs,
            cache?.lastModified,
         )
         const shouldConnect = this.state !== ResourceState.INITIAL
         const shouldSkipIfStale = !this.options.revalidateIfStale && !!cache
         this.params = params
         this.cacheKey = cacheKey
         if (cache) {
            this.source = cache.source
         }
         if ((!this.options.immutable || !cache) && !shouldDedupe && !shouldSkipIfStale) {
            const source = createFetchObservable(
               this.fetchable.fetch(...params),
            )
            this.cache?.set(cacheKey, { source, lastModified: Date.now() })
            this.source = source
         }
         if (shouldConnect) {
            this.disconnect()
            this.connect()
         } else {
            for (const [feature, options] of this.features) {
               feature.onInit?.(this, options)
            }
         }
      } catch (error) {
         this.observer.error(error)
      }
      return this
   }

   read(): FetchValue<T> | undefined {
      switch (this.state) {
         case ResourceState.ERROR: {
            this.errorHandler.handleError(this.thrownError)
            break
         }
         case ResourceState.INITIAL:
            this.connect()
            break
      }
      return this.#value
   }

   connect() {
      if (!this.connected) {
         const { timeoutMs } = this.options
         this.state = ResourceState.FETCH
         this.connected = true
         this.thrownError = undefined
         this.pending = true
         if (timeoutMs) {
            clearTimeout(this.timeout)
            this.timeout = setTimeout(Resource.slow, timeoutMs, this)
         }
         for (const [feature, options] of this.features) {
            feature.onConnect?.(this, options)
         }
         this.subscription = this.source.subscribe(this.observer)
      }
   }

   disconnect() {
      if (this.connected) {
         this.connected = false
         for (const [feature, options] of this.features) {
            feature.onDisconnect?.(this, options)
         }
         this.subscription.unsubscribe()
      }
   }

   revalidate() {
      if (this.params) {
         this.fetch(...this.params)
      }
      return this
   }

   invalidate(all: boolean = false) {
      if (all) {
         this.cache?.clear()
      } else if (this.cacheKey) {
         this.cache?.delete(this.cacheKey)
      }
      return this
   }

   getCacheKey(params: any = this.params) {
      return this.options.serialize?.(params) ?? JSON.stringify(params)
   }

   asObservable(): Observable<Resource<T>> {
      return this.observer.asObservable()
   }

   subscribe(observer?: PartialObserver<this>): Subscription
   subscribe(observer?: (value: Resource<T>) => void): Subscription
   subscribe(
      observer?: ((value: Resource<T>) => void) & PartialObserver<this>,
   ) {
      return this.asObservable().subscribe(observer)
   }

   ngOnDestroy() {
      this.disconnect()
      this.subject.complete()
      for (const [feature, options] of this.features) {
         feature.onDestroy?.(this, options)
      }
   }

   protected constructor(
      private fetchable: T,
      options: ResourceOptions,
   ) {
      this.options = { ...defaultOptions, ...options }
      this.cache = this.options.cache ? inject(CacheRegistry).get(fetchable) : null
      this.subject = new Subject()
      this.observer = new ResourceSubject<T>(
         this,
         this.subject,
         inject(ChangeDetectorRef, InjectFlags.Self | InjectFlags.Optional),
      )
      this.errorHandler = inject(ErrorHandler)
      this.source = EMPTY
      this.state = ResourceState.INITIAL
      this.subscription = Subscription.EMPTY
      this.connected = false
      this.pending = false
      this.slow = false
      this.features = options.features
         ? options.features.map(({ type, options }) => [inject(type), options])
         : []
   }

   private static slow(resource: Resource) {
      resource.observer.emit(
         ResourceState.SLOW,
         resource.#value,
         resource.pending,
         resource.thrownError,
      )
   }
}

export function createResource<T extends Fetchable<any>>(
   fetchable: Type<T>,
   options: ResourceOptions = defaultOptions,
): Type<Resource<T>> {

   @Injectable({ providedIn: options.providedIn ?? null })
   class ResourceImpl extends Resource<T> {
      static overriddenName = `Resource<${fetchable.name}>`
      constructor() {
         super(inject(fetchable), options)
      }
   }
   return ResourceImpl
}

interface ResourceFeature<T extends {} = {}> {
   onInit?(resource: Resource, options: T): void
   onConnect?(resource: Resource, options: T): void
   onDisconnect?(resource: Resource, options: T): void
   onDestroy?(resource: Resource, options: T): void
}

interface ResourceFeatureWithOptions<T extends {}> {
   type: Type<ResourceFeature>,
   options: T
}

@Injectable({ providedIn: "root" })
export class RevalidateOnFocus implements ResourceFeature<any>, OnDestroy {
   private document = inject(DOCUMENT)
   private resources = new Set<Resource>()

   handleEvent() {
      if (this.document.visibilityState === "visible") {
         for (const resource of Array.from(this.resources)) {
            resource.revalidate()
         }
      }
   }

   onConnect(resource: Resource): void {
      this.resources.add(resource)
   }

   onDisconnect(resource: Resource): void {
      this.resources.delete(resource)
   }

   ngOnDestroy() {
      this.document.removeEventListener("visibilitychange", this)
   }

   constructor() {
      this.document.addEventListener("visibilitychange", this)
   }
}

export const revalidateOnFocus = createFeature(RevalidateOnFocus)

@Injectable({ providedIn: "root" })
export class RevalidateOnReconnect implements ResourceFeature<any>, OnDestroy {
   private document = inject(DOCUMENT)
   private resources = new Set<Resource>()

   handleEvent() {
      for (const resource of Array.from(this.resources)) {
         resource.revalidate()
      }
   }

   onConnect(resource: Resource): void {
      this.resources.add(resource)
   }

   onDisconnect(resource: Resource): void {
      this.resources.delete(resource)
   }

   ngOnDestroy() {
      this.document.defaultView?.removeEventListener("online", this)
   }

   constructor() {
      this.document.defaultView?.addEventListener("online", this)
   }
}

export const revalidateOnReconnect = createFeature(RevalidateOnReconnect)

interface RevalidateIntervalOptions {
   interval: number
}

@Injectable({ providedIn: "root" })
export class RevalidateOnInterval implements ResourceFeature<RevalidateIntervalOptions> {
   private subscriptions = new Map<Resource, Subscription>()

   onInit(resource: Resource, options: RevalidateIntervalOptions) {
      if (options.interval) {
         const subscription = resource.subscribe()
         const interval = setInterval(RevalidateOnInterval.revalidate, options.interval, resource)
         subscription.add(() => clearInterval(interval))
         this.subscriptions.set(resource, subscription)
      }
   }

   onDisconnect(resource: Resource) {
      this.subscriptions.get(resource)?.unsubscribe()
   }

   static revalidate(resource: Resource) {
      resource.revalidate()
   }
}

export function refreshInterval(interval: number) {
   return createFeature(RevalidateOnInterval, { interval })
}

export function createFeature<T extends {}>(type: Type<ResourceFeature<T>>, options: T = {} as T): ResourceFeatureWithOptions<T> {
   return {
      type,
      options
   }
}
